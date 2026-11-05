import { spawn } from 'node:child_process';
import path from 'node:path';

export interface WindowsFileAssociation {
  id: string;
  label: string;
  icon?: string;
}
export interface WindowsFileAssociations {
  defaultLabel: string;
  handlers: WindowsFileAssociation[];
}

// Use Shell handlers rather than parsing registry command templates. This also
// preserves packaged-app/COM activation and never changes the user's defaults.
// Input travels as JSON on stdin, never as PowerShell source or command arguments.
export const associationScript = String.raw`
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
[Console]::InputEncoding = New-Object System.Text.UTF8Encoding
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding
try {
$request = [Console]::In.ReadToEnd() | ConvertFrom-Json
Add-Type -ReferencedAssemblies System.Drawing -TypeDefinition @'
using System;
using System.Text;
using System.IO;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Drawing;
using System.Drawing.Imaging;
public static class FileAssociations {
  [ComImport, Guid("973810ae-9599-4b88-9e4d-6ee98c9552da"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  interface IEnumHandlers {
    [PreserveSig] int Next(uint count, out IHandler handler, out uint fetched);
  }
  [ComImport, Guid("f04061ac-1659-4a3f-a954-775aa57fc083"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  interface IHandler {
    void GetName([MarshalAs(UnmanagedType.LPWStr)] out string name);
    void GetUIName([MarshalAs(UnmanagedType.LPWStr)] out string name);
    void GetIconLocation([MarshalAs(UnmanagedType.LPWStr)] out string location, out int index);
    [PreserveSig] int IsRecommended();
    void MakeDefault([MarshalAs(UnmanagedType.LPWStr)] string description);
    void Invoke([MarshalAs(UnmanagedType.Interface)] object data);
  }
  [ComImport, Guid("43826d1e-e718-42ee-bc55-a1e261c37bfe"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  interface IShellItem {
    void BindToHandler(IntPtr context, ref Guid handler, ref Guid iid, [MarshalAs(UnmanagedType.Interface)] out object data);
  }
  [DllImport("shell32.dll", CharSet=CharSet.Unicode, PreserveSig=false)]
  static extern void SHAssocEnumHandlers(string extension, uint filter, out IEnumHandlers result);
  [DllImport("shell32.dll", CharSet=CharSet.Unicode, PreserveSig=false)]
  static extern void SHCreateItemFromParsingName(string file, IntPtr context, ref Guid iid, out IShellItem item);
  [DllImport("shlwapi.dll", CharSet=CharSet.Unicode)]
  static extern int AssocQueryString(uint flags, uint kind, string association, string extra, StringBuilder output, ref uint length);
  [DllImport("shell32.dll", CharSet=CharSet.Unicode)]
  static extern uint ExtractIconEx(string file, int index, IntPtr[] large, IntPtr[] small, uint count);
  [DllImport("user32.dll")] static extern bool DestroyIcon(IntPtr icon);
  [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)]
  struct OpenAs { [MarshalAs(UnmanagedType.LPWStr)] public string file; [MarshalAs(UnmanagedType.LPWStr)] public string type; public uint flags; }
  [DllImport("shell32.dll", CharSet=CharSet.Unicode)]
  static extern int SHOpenWithDialog(IntPtr parent, ref OpenAs info);
  public class Handler { public string id; public string label; public string icon; }
  public class Result { public string defaultLabel; public List<Handler> handlers = new List<Handler>(); }
  static string Extension(string file) {
    string extension = Path.GetExtension(file);
    // Windows treats a leading-dot name as an association too, unlike Node extname.
    return extension.Length > 0 ? extension : (Path.GetFileName(file).StartsWith(".") ? Path.GetFileName(file) : "");
  }
  static string IconData(IHandler handler) {
    IntPtr[] icons = new IntPtr[1];
    try {
      string location; int index; handler.GetIconLocation(out location, out index);
      if (ExtractIconEx(Environment.ExpandEnvironmentVariables(location), index, null, icons, 1) == 0) return null;
      using (var icon = Icon.FromHandle(icons[0]))
      using (var bitmap = icon.ToBitmap())
      using (var stream = new MemoryStream()) {
        bitmap.Save(stream, ImageFormat.Png);
        return "data:image/png;base64," + Convert.ToBase64String(stream.ToArray());
      }
    } catch { return null; }
    finally { if (icons[0] != IntPtr.Zero) DestroyIcon(icons[0]); }
  }
  public static Result Query(string file) {
    string extension = Extension(file);
    var result = new Result();
    uint length = 2048; var label = new StringBuilder((int)length);
    if (extension.Length > 0 && AssocQueryString(0, 4, extension, null, label, ref length) == 0) result.defaultLabel = label.ToString();
    if (extension.Length == 0) return result;
    IEnumHandlers items;
    SHAssocEnumHandlers(extension, 1, out items);
    try {
      IHandler handler; uint fetched;
      while (items.Next(1, out handler, out fetched) == 0 && fetched == 1) {
        try {
          string id, name; handler.GetName(out id); handler.GetUIName(out name);
          result.handlers.Add(new Handler {id=id, label=name, icon=IconData(handler)});
        } finally { Marshal.ReleaseComObject(handler); }
      }
    } finally { Marshal.ReleaseComObject(items); }
    return result;
  }
  public static void Open(string file, string id) {
    file = Path.GetFullPath(file);
    if (!File.Exists(file)) throw new IOException("The selected file is no longer available");
    IEnumHandlers items;
    SHAssocEnumHandlers(Extension(file), 1, out items);
    try {
      IHandler handler; uint fetched;
      while (items.Next(1, out handler, out fetched) == 0 && fetched == 1) {
        try {
          string name; handler.GetName(out name);
          if (!String.Equals(id, name, StringComparison.OrdinalIgnoreCase)) continue;
          Guid iid = new Guid("43826d1e-e718-42ee-bc55-a1e261c37bfe"); IShellItem item;
          SHCreateItemFromParsingName(file, IntPtr.Zero, ref iid, out item);
          try {
            Guid bhid = new Guid("b8c0bd9f-ed24-455c-83e6-d5390c4fe8c4");
            Guid dataIid = new Guid("0000010e-0000-0000-c000-000000000046"); object data;
            item.BindToHandler(IntPtr.Zero, ref bhid, ref dataIid, out data);
            try { handler.Invoke(data); } finally { Marshal.ReleaseComObject(data); }
          } finally { Marshal.ReleaseComObject(item); }
          return;
        } finally { Marshal.ReleaseComObject(handler); }
      }
      throw new IOException("This application is no longer associated with the file type");
    } finally { Marshal.ReleaseComObject(items); }
  }
  public static void Choose(string file, long window) {
    file = Path.GetFullPath(file);
    var info = new OpenAs {file=file, flags=4}; // OAIF_EXEC; one-time open only.
    int status = SHOpenWithDialog(new IntPtr(window), ref info);
    if (status < 0 && status != unchecked((int)0x800704c7)) Marshal.ThrowExceptionForHR(status);
  }
}
'@
switch ($request.operation) {
  'query' { [FileAssociations]::Query($request.file) | ConvertTo-Json -Depth 5 -Compress }
  'open' { [FileAssociations]::Open($request.file, $request.id); '{}' }
  'choose' { [FileAssociations]::Choose($request.file, $request.window); '{}' }
  default { throw 'Unsupported file association operation' }
}
} catch { [Console]::Error.WriteLine($_.Exception.Message); exit 1 }
`;

async function runAssociation(request: {
  operation: 'query' | 'open' | 'choose';
  file: string;
  id?: string;
  window?: number;
}): Promise<unknown> {
  if (process.platform !== 'win32') throw new Error('Windows file associations are unavailable');
  const executable = path.join(
    process.env.SystemRoot || 'C:\\Windows',
    'System32',
    'WindowsPowerShell',
    'v1.0',
    'powershell.exe'
  );
  return new Promise((resolve, reject) => {
    const child = spawn(
      executable,
      [
        '-NoProfile',
        '-NonInteractive',
        '-STA',
        '-EncodedCommand',
        Buffer.from(associationScript, 'utf16le').toString('base64'),
      ],
      { windowsHide: true, shell: false, stdio: 'pipe' }
    );
    let output = '',
      error = '';
    const timer = setTimeout(
      () => {
        child.kill();
        reject(new Error('Reading or opening the system file association timed out'));
      },
      request.operation === 'choose' ? 300_000 : 15_000
    );
    child.on('error', (cause) => {
      clearTimeout(timer);
      reject(cause);
    });
    child.stdin.on('error', () => {});
    child.stdout.setEncoding('utf8').on('data', (chunk) => {
      output += chunk;
      if (output.length > 4_000_000) child.kill();
    });
    child.stderr.setEncoding('utf8').on('data', (chunk) => {
      error = (error + chunk).slice(-4096);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code !== 0)
        return reject(new Error(error.trim() || 'System file association is unavailable'));
      try {
        resolve(JSON.parse(output.replace(/^\uFEFF/, '')));
      } catch {
        reject(new Error('Invalid system file association response'));
      }
    });
    child.stdin.end(JSON.stringify(request));
  });
}

export async function queryWindowsAssociations(file: string): Promise<WindowsFileAssociations> {
  const result = (await runAssociation({ operation: 'query', file })) as WindowsFileAssociations;
  if (!result || !Array.isArray(result.handlers))
    throw new Error('Invalid system association list');
  return {
    defaultLabel: typeof result.defaultLabel === 'string' ? result.defaultLabel : '',
    handlers: result.handlers.filter(
      (item) => item && typeof item.id === 'string' && typeof item.label === 'string'
    ),
  };
}

export async function openWindowsAssociation(file: string, id: string) {
  await runAssociation({ operation: 'open', file, id });
}

export async function chooseWindowsApplication(file: string, window: number) {
  await runAssociation({ operation: 'choose', file, window });
}
