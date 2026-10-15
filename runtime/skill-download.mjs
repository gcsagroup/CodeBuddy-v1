import https from "node:https";
import { lookup as lookupDns } from "node:dns/promises";
import { createRequire } from "node:module";
import { createHash } from "node:crypto";

const require = createRequire(
  new URL("./harness/package.json", import.meta.url),
);
const ipaddr = require("ipaddr.js");
const invalid = (reason) =>
  Object.assign(new Error(reason), { code: -32602, data: { reason } });
export const SKILL_DOWNLOAD_LIMITS = Object.freeze({
  files: 64,
  fileBytes: 1024 * 1024,
  totalBytes: 4 * 1024 * 1024,
  redirects: 5,
  timeoutMs: 20_000,
  totalTimeoutMs: 60_000,
});
const provenanceFile = ".codebuddy-source.json";
const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");
const sha = (value) =>
  typeof value === "string" && /^[0-9a-f]{40}$/iu.test(value);

export function skillDownloadUrl(input) {
  let url;
  try {
    url = new URL(input);
  } catch {
    throw invalid("invalid_download_url");
  }
  if (
    url.protocol !== "https:" ||
    !url.hostname ||
    url.username ||
    url.password ||
    (url.port && url.port !== "443") ||
    url.hash
  )
    throw invalid("unsafe_download_url");
  return url;
}

export function publicSkillAddress(address) {
  try {
    return ipaddr.process(address).range() === "unicast";
  } catch {
    return false;
  }
}

function relativePath(value) {
  if (
    typeof value !== "string" ||
    !value ||
    value.length > 2048 ||
    value.includes("\\")
  )
    throw invalid("download_path_escape");
  const parts = value.split("/");
  if (
    parts.length > 32 ||
    parts.some(
      (part) =>
        !part ||
        part === "." ||
        part === ".." ||
        part.toLowerCase() === ".git" ||
        /[\x00-\x1f\x7f:<>"|?*]/u.test(part) ||
        /[. ]$/u.test(part) ||
        /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/iu.test(part),
    )
  )
    throw invalid("download_path_escape");
  return value;
}

function cleanUrl(url) {
  const clean = new URL(url);
  clean.search = "";
  return clean.href;
}

async function abortable(promise, signal) {
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const abort = () => reject(invalid("download_timeout"));
    signal.addEventListener("abort", abort, { once: true });
    Promise.resolve(promise)
      .then(resolve, reject)
      .finally(() => signal.removeEventListener("abort", abort));
  });
}

/** A validated address is passed to the socket lookup; DNS is not repeated. */
async function httpsBytes(url, { addresses, maxBytes, signal }) {
  return new Promise((resolve, reject) => {
    const request = https.request(
      url,
      {
        method: "GET",
        agent: false,
        signal,
        headers: {
          "user-agent": "CodeBuddy-Harness-Skill-Downloader/1",
          accept: "application/vnd.github+json",
          "accept-encoding": "identity",
        },
        lookup: (_hostname, options, callback) =>
          options.all
            ? callback(null, addresses)
            : callback(null, addresses[0].address, addresses[0].family),
      },
      (response) => {
        const status = response.statusCode;
        if (status !== 200) {
          response.destroy();
          resolve({ status, headers: response.headers, body: Buffer.alloc(0) });
          return;
        }
        if (
          Number(response.headers["content-length"]) > maxBytes ||
          (response.headers["content-encoding"] &&
            response.headers["content-encoding"] !== "identity")
        ) {
          response.destroy();
          reject(invalid("download_size_limit"));
          return;
        }
        const chunks = [];
        let bytes = 0;
        response.on("data", (chunk) => {
          bytes += chunk.length;
          if (bytes > maxBytes) {
            response.destroy();
            reject(invalid("download_size_limit"));
          } else chunks.push(chunk);
        });
        response.on("end", () =>
          resolve({
            status,
            headers: response.headers,
            body: Buffer.concat(chunks, bytes),
          }),
        );
        response.on("error", () => reject(invalid("download_failed")));
      },
    );
    request.on("error", () =>
      reject(invalid(signal.aborted ? "download_timeout" : "download_failed")),
    );
    request.end();
  });
}

export class SkillDownloader {
  constructor({
    lookup = lookupDns,
    transport = httpsBytes,
    limits = {},
  } = {}) {
    this.lookup = lookup;
    this.transport = transport;
    this.limits = { ...SKILL_DOWNLOAD_LIMITS, ...limits };
  }

  async fetch(input, maxBytes, signal, allowedHosts) {
    let url = skillDownloadUrl(input);
    for (let redirects = 0; redirects <= this.limits.redirects; redirects++) {
      signal.throwIfAborted();
      if (allowedHosts && !allowedHosts.includes(url.hostname))
        throw invalid("unexpected_download_host");
      const requestSignal = AbortSignal.any([
        signal,
        AbortSignal.timeout(this.limits.timeoutMs),
      ]);
      let addresses;
      try {
        addresses = await abortable(
          this.lookup(url.hostname.replace(/^\[|\]$/gu, ""), {
            all: true,
            verbatim: true,
          }),
          requestSignal,
        );
      } catch {
        throw invalid(
          requestSignal.aborted ? "download_timeout" : "download_dns_failed",
        );
      }
      if (
        !addresses.length ||
        addresses.some((entry) => !publicSkillAddress(entry.address))
      )
        throw invalid("private_network_rejected");
      requestSignal.throwIfAborted();
      let response;
      try {
        response = await abortable(
          this.transport(url, { addresses, maxBytes, signal: requestSignal }),
          requestSignal,
        );
      } catch (error) {
        if (requestSignal.aborted) throw invalid("download_timeout");
        if (error.code === -32602) throw error;
        throw invalid("download_failed");
      }
      if ([301, 302, 303, 307, 308].includes(response.status)) {
        if (!response.headers.location) throw invalid("invalid_redirect");
        let redirect;
        try {
          redirect = new URL(response.headers.location, url).href;
        } catch {
          throw invalid("invalid_redirect");
        }
        url = skillDownloadUrl(redirect);
        continue;
      }
      if (response.status !== 200) throw invalid("download_http_error");
      if (!Buffer.isBuffer(response.body) || response.body.length > maxBytes)
        throw invalid("download_size_limit");
      return { url, body: response.body };
    }
    throw invalid("redirect_limit");
  }

  async json(url, signal) {
    const { body } = await this.fetch(url, this.limits.totalBytes, signal, [
      "api.github.com",
    ]);
    try {
      return JSON.parse(body.toString("utf8"));
    } catch {
      throw invalid("invalid_download_response");
    }
  }

  async download(input, { signal: outerSignal } = {}) {
    const signal = AbortSignal.any([
      ...(outerSignal ? [outerSignal] : []),
      AbortSignal.timeout(this.limits.totalTimeoutMs),
    ]);
    try {
      const requested = skillDownloadUrl(input);
      let parts;
      try {
        parts = requested.pathname.slice(1).split("/").map(decodeURIComponent);
      } catch {
        throw invalid("invalid_download_url");
      }
      let files;
      let provenance;
      if (requested.hostname === "github.com" && parts[2] === "tree") {
        ({ files, provenance } = await this.github(requested, parts, signal));
      } else {
        if (parts.at(-1) !== "SKILL.md" || requested.hostname === "github.com")
          throw invalid("unsupported_download_url");
        const result = await this.fetch(
          requested,
          this.limits.fileBytes,
          signal,
        );
        files = [{ relativePath: "SKILL.md", buffer: result.body }];
        provenance = {
          kind: "https_skill_md",
          requestedUrl: cleanUrl(requested),
          resolvedUrl: cleanUrl(result.url),
          queryRedacted: Boolean(requested.search || result.url.search),
          singleFile: true,
        };
      }
      if (!files.some((file) => file.relativePath === "SKILL.md"))
        throw invalid("missing_skill_document");
      provenance.files = files.map((file) => ({
        path: file.relativePath,
        sha256: digest(file.buffer),
        bytes: file.buffer.length,
      }));
      files.push({
        relativePath: provenanceFile,
        buffer: Buffer.from(JSON.stringify(provenance, null, 2) + "\n"),
      });
      return {
        files,
        provenance,
        displaySource: `${provenance.requestedUrl}${provenance.commit ? "@" + provenance.commit : ""}`,
      };
    } catch (error) {
      if (outerSignal?.aborted) throw invalid("download_cancelled");
      if (signal.aborted) throw invalid("download_timeout");
      if (error.code === -32602) throw error;
      throw invalid("download_failed");
    }
  }

  async github(requested, parts, signal) {
    if (
      parts.length < 5 ||
      parts.slice(0, 4).some((part) => !part || /[/\\?#\x00-\x20]/u.test(part))
    )
      throw invalid("unsupported_download_url");
    const [owner, rawRepository, , reference, ...directories] = parts;
    const repository = rawRepository.replace(/\.git$/u, "");
    if (
      !/^[A-Za-z0-9_.-]+$/u.test(owner) ||
      !/^[A-Za-z0-9_.-]+$/u.test(repository)
    )
      throw invalid("unsupported_download_url");
    const directory = relativePath(directories.join("/"));
    const api = `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repository)}`;
    const commit = await this.json(
      `${api}/commits/${encodeURIComponent(reference)}`,
      signal,
    );
    if (!sha(commit?.sha) || !sha(commit.commit?.tree?.sha))
      throw invalid("invalid_github_commit");
    let treeSha = commit.commit.tree.sha;
    for (const component of directories) {
      const result = await this.json(`${api}/git/trees/${treeSha}`, signal);
      if (!Array.isArray(result.tree) || result.truncated)
        throw invalid("invalid_download_response");
      const entry = result.tree.find((row) => row.path === component);
      if (
        !entry ||
        entry.type !== "tree" ||
        entry.mode !== "040000" ||
        !sha(entry.sha)
      )
        throw invalid("unsupported_github_entry");
      treeSha = entry.sha;
    }
    const result = await this.json(
      `${api}/git/trees/${treeSha}?recursive=1`,
      signal,
    );
    if (!Array.isArray(result.tree) || result.truncated)
      throw invalid("invalid_download_response");
    const entries = [];
    const paths = new Set();
    let total = 0;
    if (result.tree.length > this.limits.files * 2)
      throw invalid("download_file_limit");
    for (const entry of result.tree) {
      const name = relativePath(entry.path);
      const folded = name.toLowerCase();
      if (paths.has(folded) || folded === provenanceFile)
        throw invalid("download_path_escape");
      paths.add(folded);
      if (entry.type === "tree" && entry.mode === "040000") continue;
      if (entry.type !== "blob" || !["100644", "100755"].includes(entry.mode))
        throw invalid("linked_download_entry");
      if (
        !sha(entry.sha) ||
        !Number.isSafeInteger(entry.size) ||
        entry.size < 0
      )
        throw invalid("invalid_download_response");
      if (
        entry.size > this.limits.fileBytes ||
        (total += entry.size) > this.limits.totalBytes
      )
        throw invalid("download_size_limit");
      if (entries.length >= this.limits.files)
        throw invalid("download_file_limit");
      entries.push({ ...entry, relativePath: name });
    }
    if (!entries.some((entry) => entry.relativePath === "SKILL.md"))
      throw invalid("missing_skill_document");
    const files = [];
    for (const entry of entries) {
      const segments = [
        owner,
        repository,
        commit.sha,
        ...directories,
        ...entry.relativePath.split("/"),
      ];
      const url =
        "https://raw.githubusercontent.com/" +
        segments.map(encodeURIComponent).join("/");
      const { body } = await this.fetch(url, this.limits.fileBytes, signal, [
        "raw.githubusercontent.com",
      ]);
      const hash = createHash("sha1")
        .update(`blob ${body.length}\0`)
        .update(body)
        .digest("hex");
      if (body.length !== entry.size || hash !== entry.sha.toLowerCase())
        throw invalid("invalid_download_response");
      files.push({
        relativePath: entry.relativePath,
        buffer: body,
        executable: entry.mode === "100755",
      });
    }
    return {
      files,
      provenance: {
        kind: "github_directory",
        requestedUrl: cleanUrl(requested),
        commit: commit.sha,
        directory,
      },
    };
  }
}
