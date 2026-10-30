import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';

// Windows hotkeys cannot distinguish SendInput from a human pressing Escape.
// This small, non-UI worker observes only Escape and never emits keyboard input.
export const keyboardScript = String.raw`
$ErrorActionPreference='Stop'
Add-Type -ReferencedAssemblies System.Windows.Forms -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
using System.Threading;
using System.Windows.Forms;
public static class ControlEscape {
    delegate IntPtr Callback(int code, IntPtr message, IntPtr data);
    [StructLayout(LayoutKind.Sequential)] struct Key {public uint Vk, Scan, Flags, Time; public UIntPtr Extra;}
    [DllImport("user32.dll",SetLastError=true)] static extern IntPtr SetWindowsHookEx(int type, Callback callback, IntPtr module, uint thread);
    [DllImport("user32.dll")] static extern bool UnhookWindowsHookEx(IntPtr hook);
    [DllImport("user32.dll")] static extern IntPtr CallNextHookEx(IntPtr hook,int code,IntPtr message,IntPtr data);
    [DllImport("user32.dll")] static extern short GetAsyncKeyState(int key);
    [DllImport("kernel32.dll",CharSet=CharSet.Unicode)] static extern IntPtr GetModuleHandle(string name);
    static readonly Callback Handler=OnKey;
    static IntPtr hook;
    static string token="";
    static bool held;
    public static bool HumanEscape(uint vk,uint flags,bool modified) {return vk==0x1B && (flags&0x12)==0 && !modified;}
    static IntPtr OnKey(int code,IntPtr message,IntPtr data) {
        if(code>=0) {
            var key=(Key)Marshal.PtrToStructure(data,typeof(Key));
            bool down=message.ToInt64()==0x100 || message.ToInt64()==0x104;
            if(key.Vk==0x1B && (key.Flags&0x12)==0 && !down) held=false;
            var current=Volatile.Read(ref token);
            if(current.Length==0 || key.Vk!=0x1B) return CallNextHookEx(hook,code,message,data);
            bool modified=false;
            foreach(int modifier in new int[]{0x10,0x11,0x12,0x5B,0x5C}) if((GetAsyncKeyState(modifier)&0x8000)!=0) modified=true;
            if(current.Length>0 && HumanEscape(key.Vk,key.Flags,modified)) {
                if(down && !held) {held=true;Console.WriteLine("cancel "+current);Console.Out.Flush();}
                if(!down) held=false;
                return new IntPtr(1);
            }
        }
        return CallNextHookEx(hook,code,message,data);
    }
    public static void Run() {
        hook=SetWindowsHookEx(13,Handler,GetModuleHandle(null),0);
        if(hook==IntPtr.Zero) throw new System.ComponentModel.Win32Exception();
        var reader=new Thread(delegate() {
            string line;
            while((line=Console.ReadLine())!=null) {
                if(!line.StartsWith("arm ")) continue;
                string next=line.Substring(4);
                if(next.Length>256) continue;
                Volatile.Write(ref token,next);
                Console.WriteLine("armed "+next);Console.Out.Flush();
            }
            Application.Exit();
        });
        reader.IsBackground=true;reader.Start();
        Console.WriteLine("ready");Console.Out.Flush();
        try {Application.Run();} finally {UnhookWindowsHookEx(hook);}
    }
}
'@
[ControlEscape]::Run()
`;

export function createDesktopEscape(
  onCancel: (token: string) => void,
  onReady: (ready: boolean) => void,
  macHelper?: string
) {
  let worker: ChildProcessWithoutNullStreams | undefined;
  let pending = '';
  let ready = false;
  let buffer = '';
  return {
    arm(token: string) {
      pending = token;
      if (process.platform !== 'win32' && !(process.platform === 'darwin' && macHelper)) return;
      if (!worker && token) {
        buffer = '';
        worker = spawn(
          process.platform === 'darwin' ? macHelper! : 'powershell.exe',
          process.platform === 'darwin' ? ['--watch-escape'] : [
            '-NoProfile',
            '-NonInteractive',
            '-EncodedCommand',
            Buffer.from(keyboardScript, 'utf16le').toString('base64'),
          ],
          { windowsHide: true }
        );
        const current = worker;
        const failed = () => {
          if (worker === current) {
            current.kill();
            worker = undefined;
            ready = false;
            onReady(false);
          }
        };
        current.on('error', failed);
        current.on('exit', failed);
        current.stderr.resume();
        current.stdin.on('error', failed);
        current.stdout.setEncoding('utf8');
        current.stdout.on('data', (chunk: string) => {
          if (worker !== current) return;
          buffer += chunk;
          let newline;
          while ((newline = buffer.indexOf('\n')) >= 0) {
            const line = buffer.slice(0, newline).trimEnd();
            buffer = buffer.slice(newline + 1);
            if (line === 'ready') {
              ready = true;
              current.stdin.write(`arm ${pending}\n`);
            } else if (line === `armed ${pending}`) onReady(Boolean(pending));
            else if (line.startsWith('cancel ') && line.slice(7) === pending) onCancel(pending);
          }
        });
      } else if (ready) worker?.stdin.write(`arm ${token}\n`);
    },
    close() {
      pending = '';
      worker?.kill();
      worker = undefined;
      ready = false;
    },
  };
}
