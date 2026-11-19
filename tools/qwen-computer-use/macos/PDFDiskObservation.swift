import Foundation
import PDFKit
import Darwin

// The caller supplies AXDocument from the matched window, never a model path.
enum PDFDiskObservation {
    static func read(documentURL: String) -> [String: Any]? {
        guard let url = URL(string: documentURL), url.isFileURL,
              url.host == nil || url.host == "" || url.host == "localhost",
              url.pathExtension.lowercased() == "pdf" else { return nil }
        let start = Date()
        var result: [String: Any] = ["source": "local_pdf_disk", "document_url": documentURL,
            "status": "unavailable", "notice": "Disk snapshot only; compare its exact field values with the current UI and requested changes. This does not authorize saving or submitting."]
        do {
            let path = url.resolvingSymlinksInPath().path
            let handle = try FileHandle(forReadingFrom: URL(fileURLWithPath: path))
            defer { try? handle.close() }
            var before = stat()
            guard fstat(handle.fileDescriptor, &before) == 0,
                  (before.st_mode & S_IFMT) == S_IFREG,
                  before.st_size > 0, before.st_size <= 16 * 1024 * 1024 else {
                throw RuntimeFailure("PDF must be a regular local file no larger than 16 MiB.")
            }
            var data = Data()
            while data.count <= 16 * 1024 * 1024 {
                let chunk = try handle.read(upToCount: min(64 * 1024, 16 * 1024 * 1024 + 1 - data.count)) ?? Data()
                if chunk.isEmpty { break }
                data.append(chunk)
            }
            guard data.count == before.st_size,
                  let document = PDFDocument(data: data), !document.isLocked,
                  document.pageCount > 0, document.pageCount <= 100 else {
                throw RuntimeFailure("PDF changed, could not be decoded, is locked, or exceeds the 100-page observation limit.")
            }
            var fields: [[String: Any]] = []
            var textBytes = 0
            for pageIndex in 0..<document.pageCount {
                guard let page = document.page(at: pageIndex) else { throw RuntimeFailure("PDF page could not be read.") }
                for (annotationIndex, annotation) in page.annotations.enumerated() where annotation.type == "Widget" {
                    let name = annotation.fieldName
                    let value = annotation.widgetStringValue
                    textBytes += (name?.utf8.count ?? 0) + (value?.utf8.count ?? 0)
                    guard fields.count < 256, textBytes <= 32 * 1024 else {
                        throw RuntimeFailure("PDF form exceeds the 256-widget or 32 KiB field-text observation limit; no partial values are reported.")
                    }
                    fields.append(["page": pageIndex + 1, "annotation": annotationIndex,
                        "name": name as Any? ?? NSNull(), "value": value as Any? ?? NSNull()])
                }
            }
            var after = stat(), currentPath = stat()
            guard fstat(handle.fileDescriptor, &after) == 0, lstat(path, &currentPath) == 0,
                  sameFile(before, after), sameFile(before, currentPath) else {
                throw RuntimeFailure("PDF changed or was replaced while reading; observe again before claiming persistence.")
            }
            result["status"] = "read"
            result["fields"] = fields
            result["page_count"] = document.pageCount
            result["file_bytes"] = data.count
            result["modified_at"] = ISO8601DateFormatter().string(from: Date(timeIntervalSince1970:
                Double(before.st_mtimespec.tv_sec) + Double(before.st_mtimespec.tv_nsec) / 1_000_000_000))
        } catch {
            result["reason"] = String(describing: error)
        }
        result["elapsed_ms"] = Date().timeIntervalSince(start) * 1000
        return result
    }

    private static func sameFile(_ a: stat, _ b: stat) -> Bool {
        a.st_dev == b.st_dev && a.st_ino == b.st_ino && a.st_size == b.st_size &&
            a.st_mtimespec.tv_sec == b.st_mtimespec.tv_sec && a.st_mtimespec.tv_nsec == b.st_mtimespec.tv_nsec &&
            a.st_ctimespec.tv_sec == b.st_ctimespec.tv_sec && a.st_ctimespec.tv_nsec == b.st_ctimespec.tv_nsec
    }
}
