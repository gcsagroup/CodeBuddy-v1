using System;
using System.Collections.Generic;
using System.ComponentModel;
using System.Runtime.InteropServices;
using System.Threading;
using System.Text;

// Foreground input is opt-in; all coordinates use physical desktop pixels.
public static class OcuDesktop {
    [StructLayout(LayoutKind.Sequential)] public struct Point { public int X, Y; }
    [StructLayout(LayoutKind.Sequential)] public struct Rect { public int Left, Top, Right, Bottom; }
    [StructLayout(LayoutKind.Sequential)] struct Mouse { public int dx, dy; public uint data, flags, time; public UIntPtr extra; }
    [StructLayout(LayoutKind.Sequential)] struct Keyboard { public ushort vk, scan; public uint flags, time; public UIntPtr extra; }
    [StructLayout(LayoutKind.Explicit)] struct Union { [FieldOffset(0)] public Mouse mouse; [FieldOffset(0)] public Keyboard key; }
    [StructLayout(LayoutKind.Sequential)] struct Input { public uint type; public Union data; }
    [DllImport("user32.dll", SetLastError=true)] static extern uint SendInput(uint count, Input[] inputs, int size);
    [DllImport("user32.dll")] public static extern IntPtr SetThreadDpiAwarenessContext(IntPtr context);
    [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr window, out Rect rect);
    [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr window);
    [DllImport("user32.dll")] public static extern bool PrintWindow(IntPtr window, IntPtr dc, uint flags);
    [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")] static extern bool SetForegroundWindow(IntPtr window);
    [DllImport("user32.dll")] static extern bool BringWindowToTop(IntPtr window);
    [DllImport("user32.dll", SetLastError=true)] static extern bool AttachThreadInput(uint source, uint target, bool attach);
    [DllImport("kernel32.dll")] static extern uint GetCurrentThreadId();
    [StructLayout(LayoutKind.Sequential)] struct NativeMessage {
        public IntPtr Window; public uint Message; public UIntPtr WParam; public IntPtr LParam;
        public uint Time; public Point Point; public uint Private;
    }
    [DllImport("user32.dll")] static extern bool PeekMessage(out NativeMessage message, IntPtr window, uint first, uint last, uint remove);
    [DllImport("user32.dll")] static extern bool ShowWindowAsync(IntPtr window, int command);
    [DllImport("user32.dll")] static extern IntPtr WindowFromPoint(Point point);
    [DllImport("user32.dll")] static extern IntPtr GetAncestor(IntPtr window, uint flags);
    [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr window, out uint process);
    [DllImport("user32.dll")] static extern bool SetCursorPos(int x, int y);
    [DllImport("user32.dll")] static extern short GetAsyncKeyState(int key);
    delegate bool EnumWindowProc(IntPtr window, IntPtr data);
    [DllImport("user32.dll")] static extern bool EnumWindows(EnumWindowProc callback, IntPtr data);
    [DllImport("user32.dll")] static extern bool EnumChildWindows(IntPtr parent, EnumWindowProc callback, IntPtr data);
    [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr window);
    [DllImport("user32.dll")] static extern int GetWindowLong(IntPtr window, int index);
    [StructLayout(LayoutKind.Sequential)] struct GuiThreadInfo {
        public int Size, Flags;
        public IntPtr Active, Focus, Capture, MenuOwner, MoveSize, Caret;
        public Rect CaretRect;
    }
    [DllImport("user32.dll")] static extern bool GetGUIThreadInfo(uint thread, ref GuiThreadInfo info);
    public static IntPtr FocusedChild(IntPtr window) {
        if (GetForegroundWindow()!=window) return IntPtr.Zero;
        uint pid;
        uint thread=GetWindowThreadProcessId(window,out pid);
        var info=new GuiThreadInfo {Size=Marshal.SizeOf(typeof(GuiThreadInfo))};
        if (thread==0 || !GetGUIThreadInfo(thread,ref info) || info.Focus==IntPtr.Zero ||
            GetAncestor(info.Focus,2)!=window || WindowProcessId(info.Focus)!=pid) return IntPtr.Zero;
        return info.Focus;
    }
    [DllImport("user32.dll", CharSet=CharSet.Unicode)] static extern int GetClassName(IntPtr window, StringBuilder name, int size);
    [DllImport("user32.dll", CharSet=CharSet.Unicode)] static extern IntPtr SendMessageTimeout(IntPtr window, uint message,
        UIntPtr wparam, IntPtr lparam, uint flags, uint timeout, out UIntPtr result);
    [DllImport("user32.dll", CharSet=CharSet.Unicode)] static extern IntPtr SendMessageTimeout(IntPtr window, uint message,
        UIntPtr wparam, StringBuilder text, uint flags, uint timeout, out UIntPtr result);
    // UIA can expose a WinForms EDIT as a generic pane without ValuePattern.
    // Read only short visible standard edit controls belonging to this exact window.
    public static string ReadEditText(IntPtr root, IntPtr child) {
        if (child==IntPtr.Zero || root==child || GetAncestor(child,2)!=root ||
            WindowProcessId(root)!=WindowProcessId(child) || !IsWindowVisible(child)) return null;
        var cls=new StringBuilder(256);
        if (GetClassName(child,cls,cls.Capacity)==0) return null;
        string name=cls.ToString();
        if (!name.Equals("Edit",StringComparison.OrdinalIgnoreCase) &&
            !name.StartsWith("WindowsForms10.EDIT.",StringComparison.OrdinalIgnoreCase)) return null;
        UIntPtr result;
        if ((GetWindowLong(child,-16)&0x20)!=0 ||
            SendMessageTimeout(child,0x00D2,UIntPtr.Zero,IntPtr.Zero,2,80,out result)==IntPtr.Zero ||
            result!=UIntPtr.Zero) return null;
        var text=new StringBuilder(502);
        if (SendMessageTimeout(child,0x000D,(UIntPtr)text.Capacity,text,2,80,out result)==IntPtr.Zero ||
            result.ToUInt64()>=501) return null;
        return text.ToString();
    }
    [DllImport("user32.dll")] static extern bool IsWindowEnabled(IntPtr window);
    public static bool CanSetEditText(IntPtr root, IntPtr child) {
        return IsWindowEnabled(root) && IsWindowEnabled(child) && (GetWindowLong(child,-16)&0x800)==0 && ReadEditText(root,child)!=null;
    }
    // Use the existing tagged input and takeover gate, not an unguarded background write.
    public static void SetEditText(IntPtr root, IntPtr child, string expected, string value) {
        if(value==null || value.Length>500 || value.IndexOfAny(new char[]{'\r','\n','\0'})>=0)
            throw new InvalidOperationException("Native edit replacement requires a short single-line value; no input dispatched.");
        RequireForeground(root);
        if(!CanSetEditText(root,child) || ReadEditText(root,child)!=expected)
            throw new InvalidOperationException("Native edit changed or is not writable; observe again. No input dispatched.");
        Rect rect;
        if(!GetWindowRect(child,out rect)) throw new InvalidOperationException("Native edit bounds unavailable.");
        int x=(rect.Left+rect.Right)/2,y=(rect.Top+rect.Bottom)/2;
        if(WindowFromPoint(new Point{X=x,Y=y})!=child)
            throw new InvalidOperationException("Native edit is covered; no input dispatched.");
        Click(root,x,y,"left",1);
        for(int attempt=0;attempt<20 && FocusedChild(root)!=child;attempt++) { OcuControl.Check(); Thread.Sleep(10); }
        if(FocusedChild(root)!=child || ReadEditText(root,child)!=expected)
            throw new InvalidOperationException("Native edit focus or value changed; no text dispatched.");
        Chord(root,new ushort[]{0x11},0x41);
        if(FocusedChild(root)!=child) throw new InvalidOperationException("Native edit lost focus; no text dispatched.");
        if(value.Length==0) Chord(root,new ushort[]{},0x08);
        else Type(root,value);
    }
    [DllImport("user32.dll", CharSet=CharSet.Unicode)] static extern int GetWindowText(IntPtr window, StringBuilder text, int size);

    public static IntPtr[] VisibleWindows() {
        var windows=new List<IntPtr>();
        EnumWindows(delegate(IntPtr window,IntPtr ignored) {
            if (WindowVisible(window) && (GetWindowLong(window,-20)&0x80)==0 && Title(window).Length>0) windows.Add(window);
            return true;
        },IntPtr.Zero);
        return windows.ToArray();
    }
    public static IntPtr ForegroundWindow() { return GetForegroundWindow(); }
    [DllImport("dwmapi.dll")] static extern int DwmGetWindowAttribute(IntPtr window, int attribute, out uint value, int size);
    public static bool WindowVisible(IntPtr window) {
        if (!IsWindowVisible(window)) return false;
        // A cloaked UWP window can retain WS_VISIBLE and cached PrintWindow pixels.
        uint cloaked;
        return DwmGetWindowAttribute(window,14,out cloaked,4)>=0 && cloaked==0;
    }
    public static uint WindowProcessId(IntPtr window) { uint pid; GetWindowThreadProcessId(window, out pid); return pid; }
    public static bool BelongsToProcess(IntPtr window, int process) {
        uint actual; return window!=IntPtr.Zero && GetWindowThreadProcessId(window,out actual)!=0 && actual==(uint)process;
    }
    public static string Title(IntPtr window) {
        var title=new StringBuilder(1024); GetWindowText(window,title,title.Capacity); return title.ToString();
    }
    public static IntPtr InitialWindow(int process, IntPtr candidate) {
        // Hosted apps can expose a child HWND owned by a different process from
        // their top-level frame. Activation and screenshots must use that frame.
        IntPtr root=GetAncestor(candidate,2);
        if (root!=IntPtr.Zero && root!=candidate && BelongsToProcess(candidate,process)) return root;
        // MainWindowHandle may be a detached/hidden CoreWindow while the real
        // app content is a different child of a shell-owned top-level frame.
        var hosts=new List<IntPtr>();
        EnumWindows(delegate(IntPtr frame,IntPtr data) {
            if (!IsWindowVisible(frame) || BelongsToProcess(frame,process)) return true;
            bool found=false;
            EnumChildWindows(frame,delegate(IntPtr child,IntPtr ignored) {
                if (BelongsToProcess(child,process)) {found=true;return false;}
                return true;
            },IntPtr.Zero);
            if (found) hosts.Add(frame);
            return true;
        },IntPtr.Zero);
        if (hosts.Count==1) return hosts[0];
        if (hosts.Count>1) throw new InvalidOperationException("Multiple hosted windows match the app; observe the specific frame before input.");
        // Process.MainWindowHandle may point to a transient selection toolbar.
        // Prefer its normal captioned window; later observations bind this handle.
        if ((GetWindowLong(candidate,-16)&0x00C00000)!=0 && (GetWindowLong(candidate,-20)&0x80)==0) return candidate;
        IntPtr best=IntPtr.Zero; long area=0;
        EnumWindows(delegate(IntPtr window,IntPtr data) {
            if (!BelongsToProcess(window,process) || !IsWindowVisible(window) || (GetWindowLong(window,-20)&0x80)!=0 || (GetWindowLong(window,-16)&0x00C00000)==0) return true;
            Rect r; if(GetWindowRect(window,out r)) {long size=(long)(r.Right-r.Left)*(r.Bottom-r.Top);if(size>area){best=window;area=size;}}
            return true;
        },IntPtr.Zero);
        return best==IntPtr.Zero?candidate:best;
    }

    public static void PhysicalPixels() {
        if (SetThreadDpiAwarenessContext(new IntPtr(-4)) == IntPtr.Zero)
            throw new Win32Exception("Could not establish per-monitor physical coordinates");
    }
    public static void RequireForeground(IntPtr window) {
        OcuControl.Check();
        if (GetForegroundWindow() != window) throw new InvalidOperationException("Target lost foreground; no further input dispatched. Re-observe.");
    }
    public static bool IsForeground(IntPtr window) {return GetForegroundWindow()==window;}
    public static void Raise(IntPtr window) {
        OcuControl.Check();
        if (IsIconic(window)) ShowWindowAsync(window, 9);
        if (GetForegroundWindow()==window) return;
        RequireReleasedModifiers();
        if (GetForegroundWindow() != window) SetForegroundWindow(window);
        if (GetForegroundWindow()!=window) {
            uint ignored;
            uint current=GetCurrentThreadId();
            uint foreground=GetWindowThreadProcessId(GetForegroundWindow(),out ignored);
            uint target=GetWindowThreadProcessId(window,out ignored);
            bool foregroundAttached=false, targetAttached=false;
            try {
                // PowerShell stream workers need not have a USER message queue.
                // AttachThreadInput fails without one; PeekMessage creates it without consuming messages.
                NativeMessage message;
                PeekMessage(out message,IntPtr.Zero,0,0,0);
                // Join only for activation, then always detach. No synthetic Alt
                // key or persistent foreground-lock setting is needed.
                if (foreground!=0 && foreground!=current) foregroundAttached=AttachThreadInput(current,foreground,true);
                if (target!=0 && target!=current && target!=foreground) targetAttached=AttachThreadInput(current,target,true);
                BringWindowToTop(window);
                SetForegroundWindow(window);
            } finally {
                if (targetAttached) AttachThreadInput(current,target,false);
                if (foregroundAttached) AttachThreadInput(current,foreground,false);
            }
        }
        for (int i=0; i<10 && GetForegroundWindow()!=window; i++) { OcuControl.Check(); Thread.Sleep(30); }
        if (GetForegroundWindow()!=window) throw new InvalidOperationException("Target activation was denied; no input dispatched. Ask the user to bring the exact target window to the foreground. Do not retry input, Raise, shortcuts, or alternative activation methods while it remains in the background. Continue only after a fresh observation confirms that target is foreground.");
    }
    static void RequireReleasedModifiers() {
        foreach (int key in new int[] {0x10,0x11,0x12,0x5B,0x5C})
            if ((GetAsyncKeyState(key) & 0x8000) != 0) throw new InvalidOperationException("A modifier is held; input not dispatched.");
    }
    static void Dispatch(Input[] events) {
        OcuControl.Check();
        uint sent=SendInput((uint)events.Length, events, Marshal.SizeOf(typeof(Input)));
        if (sent!=events.Length) {
            var held=new Dictionary<string,Input>();
            for(int i=0;i<sent;i++) {
                var value=events[i];
                if(value.type==1) {
                    string key=value.data.key.vk+":"+value.data.key.scan;
                    if((value.data.key.flags&2)!=0)held.Remove(key);
                    else {value.data.key.flags|=2;held[key]=value;}
                } else {
                    foreach(uint down in new uint[]{2,8,32}) {
                        if((value.data.mouse.flags&(down*2))!=0)held.Remove("mouse"+down);
                        if((value.data.mouse.flags&down)!=0)held["mouse"+down]=MouseEvent(down*2);
                    }
                }
            }
            var cleanup=new List<Input>(held.Values).ToArray();
            if(cleanup.Length>0)SendInput((uint)cleanup.Length,cleanup,Marshal.SizeOf(typeof(Input)));
            throw new Win32Exception("Input partially dispatched or blocked; outcome unknown. Do not retry blindly.");
        }
    }
    static Input Key(ushort vk, ushort scan, uint flags) {
        return new Input {type=1, data=new Union {key=new Keyboard {vk=vk,scan=scan,flags=flags,extra=OcuControl.InputTag}}};
    }
    static Input MouseEvent(uint flags, uint data=0) {
        return new Input {type=0,data=new Union {mouse=new Mouse {flags=flags,data=data,extra=OcuControl.InputTag}}};
    }
    [DllImport("user32.dll")] static extern int GetSystemMetrics(int index);
    static void Move(int x,int y) {
        OcuControl.Check();
        int left=GetSystemMetrics(76), top=GetSystemMetrics(77), width=GetSystemMetrics(78), height=GetSystemMetrics(79);
        if(width<1 || height<1) throw new InvalidOperationException("Desktop bounds unavailable");
        var input=MouseEvent(0xC001);
        input.data.mouse.dx=(int)Math.Round((x-left+0.5)*65536.0/width);
        input.data.mouse.dy=(int)Math.Round((y-top+0.5)*65536.0/height);
        Dispatch(new Input[]{input});
    }
    static void ReleaseMouse() {
        // Cleanup deliberately bypasses the pause gate, and releases only our drag.
        var up=MouseEvent(4); SendInput(1,new Input[]{up},Marshal.SizeOf(typeof(Input)));
    }
    public static void ValidatePoint(IntPtr window, int x, int y) {
        Rect r;
        if (!GetWindowRect(window,out r) || x<r.Left || y<r.Top || x>=r.Right || y>=r.Bottom)
            throw new InvalidOperationException("Point outside target window; re-observe.");
        var hit=GetAncestor(WindowFromPoint(new Point{X=x,Y=y}),2);
        uint targetProcess, hitProcess;
        GetWindowThreadProcessId(window,out targetProcess);
        GetWindowThreadProcessId(hit,out hitProcess);
        // Qt popups may have no Win32 owner, but remain in the observed app's
        // process and inside the captured main-window rectangle checked above.
        if (hit!=window && GetAncestor(hit,3)!=GetAncestor(window,3) && (targetProcess==0 || targetProcess!=hitProcess))
            throw new InvalidOperationException("Point covered by another window; re-observe.");
    }
    public static void Click(IntPtr window,int x,int y,string button,int count) {
        RequireForeground(window); RequireReleasedModifiers(); ValidatePoint(window,x,y);
        Move(x,y);
        uint down=2,up=4;
        if (button=="right") {down=8;up=16;} else if(button=="middle") {down=32;up=64;}
        for(int i=0;i<count;i++) {RequireForeground(window);ValidatePoint(window,x,y);Dispatch(new Input[]{MouseEvent(down),MouseEvent(up)}); if(i+1<count)Thread.Sleep(60);}
    }
    public static void Type(IntPtr window,string text) {
        RequireForeground(window); RequireReleasedModifiers();
        var events=TextInputs(text);
        // Keep Unicode down/up pairs and surrogate pairs together. Check takeover
        // between chunks without imposing animation delays on ordinary typing.
        for(int offset=0;offset<events.Length;offset+=128) {
            RequireForeground(window);
            int count=Math.Min(128,events.Length-offset);
            if(offset+count<events.Length && Char.IsHighSurrogate((char)events[offset+count-2].data.key.scan))count-=2;
            var chunk=new Input[count];Array.Copy(events,offset,chunk,0,count);Dispatch(chunk);
            if(count<128 && offset+count<events.Length)offset-=128-count;
        }
    }
    static Input[] TextInputs(string text) {
        if (text.IndexOfAny(new char[]{'\r','\n'}) >= 0)
            throw new InvalidOperationException("Multiline keyboard text is not supported reliably by Windows controls; no text dispatched. Use set_value on an observed editable element only when replacing its complete value is intended, or use observed editor-specific line-break controls.");
        var inputs=new List<Input>();
        // Never turn literal newlines into an Enter/Shift+Enter submit shortcut.
        foreach(char ch in text) {
            inputs.Add(Key(0,ch,4)); inputs.Add(Key(0,ch,6));
        }
        return inputs.ToArray();
    }
    [DllImport("user32.dll")] static extern IntPtr GetKeyboardLayout(uint thread);
    [DllImport("user32.dll", CharSet=CharSet.Unicode)] static extern short VkKeyScanEx(char value, IntPtr layout);
    public static int CharacterKey(IntPtr window,char value) {
        uint owner; uint thread=GetWindowThreadProcessId(window,out owner);
        short key=VkKeyScanEx(value,GetKeyboardLayout(thread));
        if (key==-1 || (key&0xF800)!=0) throw new InvalidOperationException("Character is unavailable on the target keyboard layout; use type_text for literal text.");
        return key;
    }
    public static void Chord(IntPtr window,ushort[] modifiers,ushort key) {
        RequireForeground(window); RequireReleasedModifiers();
        var inputs=new List<Input>();
        foreach(ushort modifier in modifiers) inputs.Add(Key(modifier,0,0));
        uint extended=(key>=0x21 && key<=0x2E)?1u:0u;
        inputs.Add(Key(key,0,extended)); inputs.Add(Key(key,0,extended|2));
        for(int i=modifiers.Length-1;i>=0;i--) inputs.Add(Key(modifiers[i],0,2));
        Dispatch(inputs.ToArray());
    }
    public static void Scroll(IntPtr window,int x,int y,bool horizontal,int delta) {
        RequireForeground(window); RequireReleasedModifiers(); ValidatePoint(window,x,y);
        Move(x,y);
        Dispatch(new Input[]{MouseEvent(horizontal?0x1000u:0x800u,unchecked((uint)delta))});
    }
    public static void Drag(IntPtr window,int x1,int y1,int x2,int y2) {
        RequireForeground(window);RequireReleasedModifiers();ValidatePoint(window,x1,y1);ValidatePoint(window,x2,y2);
        Move(x1,y1);
        Dispatch(new Input[]{MouseEvent(2)});
        try { for(int i=1;i<=12;i++){RequireForeground(window);Move(x1+(x2-x1)*i/12,y1+(y2-y1)*i/12);Thread.Sleep(15);} }
        finally {ReleaseMouse();}
    }
}

// The hooks run independently of PowerShell's synchronous UIA calls. A persistent
// marker fences every CodeBuddy profile; only the host's explicit resume clears it.
public sealed class DesktopInputConflictException : InvalidOperationException {
    public DesktopInputConflictException(string message) : base(message) {}
}
public static class OcuControl {
    public const uint InputMarker=0x43425544;
    public static UIntPtr InputTag {get{return new UIntPtr(((ulong)(uint)System.Diagnostics.Process.GetCurrentProcess().Id<<32)|InputMarker);}}
    delegate IntPtr Hook(int code,IntPtr message,IntPtr data);
    [StructLayout(LayoutKind.Sequential)] struct Mouse {public int X,Y;public uint Data,Flags,Time;public UIntPtr Extra;}
    [StructLayout(LayoutKind.Sequential)] struct Key {public uint Vk,Scan,Flags,Time;public UIntPtr Extra;}
    [StructLayout(LayoutKind.Sequential)] struct Message {public IntPtr Window;public uint Id;public UIntPtr W;public IntPtr L;public uint Time;public int X,Y;public uint Private;}
    [DllImport("user32.dll",SetLastError=true)] static extern IntPtr SetWindowsHookEx(int kind,Hook callback,IntPtr module,uint thread);
    [DllImport("user32.dll")] static extern IntPtr CallNextHookEx(IntPtr hook,int code,IntPtr message,IntPtr data);
    [DllImport("user32.dll")] static extern bool GetMessage(out Message message,IntPtr window,uint first,uint last);
    [DllImport("user32.dll")] static extern bool TranslateMessage(ref Message message);
    [DllImport("user32.dll")] static extern IntPtr DispatchMessage(ref Message message);
    [DllImport("kernel32.dll",CharSet=CharSet.Unicode)] static extern IntPtr GetModuleHandle(string name);
    static readonly Hook MouseHandler=OnMouse, KeyHandler=OnKey;
    static readonly ManualResetEvent Ready=new ManualResetEvent(false);
    static Thread thread;
    static Exception hookError;
    static volatile string directory="",identity="";
    static bool ownsMutex;
    static long inputVersion, observedVersion, lastInputTicks;
    static string lastInputKind="input";
    static readonly object inputLock=new object();
    static readonly HashSet<uint> heldKeys=new HashSet<uint>();
    static int heldButtons;
    static Mutex mutex;
    static bool Current() {
        try { return identity.Length>0 && !System.IO.File.Exists(System.IO.Path.Combine(directory,"paused")) && System.IO.File.ReadAllText(System.IO.Path.Combine(directory,"lease.json"))==identity; }
        catch {return false;}
    }
    static void Takeover(string reason) {
        if(!Current())return;
        try {using(var file=new System.IO.FileStream(System.IO.Path.Combine(directory,"paused"),System.IO.FileMode.CreateNew,System.IO.FileAccess.Write,System.IO.FileShare.Read)) {
            byte[] data=Encoding.UTF8.GetBytes("{\"revision\":\""+Guid.NewGuid().ToString()+"\",\"reason\":\""+reason+"\",\"at\":\""+DateTime.UtcNow.ToString("o")+"\"}");file.Write(data,0,data.Length);
        }} catch(System.IO.IOException) {};
    }
    public static bool ExternalInput(uint flags,ulong extra) {return (uint)extra!=InputMarker;}
    // Pointer motion alone is not a request to take over. Clicks, wheels and
    // typing invalidate observations without leaving a persistent pause latch.
    public static void RecordInput(bool escape) {
        if(escape) {Takeover("escape");return;}
        Interlocked.Exchange(ref lastInputTicks,DateTime.UtcNow.Ticks);
        Interlocked.Increment(ref inputVersion);
    }
    public static void RecordMouse(long kind, bool injected=false) {
        int bit=kind==0x201||kind==0x202?1:kind==0x204||kind==0x205?2:kind==0x207||kind==0x208?4:kind==0x20B||kind==0x20C?8:0;
        if(bit!=0) {
            lastInputKind=injected?"injected mouse button":"mouse button";
            lock(inputLock) {
                if(kind==0x201||kind==0x204||kind==0x207||kind==0x20B)heldButtons|=bit;
                else heldButtons&=~bit;
            }
            RecordInput(false);
        } else if(kind==0x20A||kind==0x20E) {
            lastInputKind=injected?"injected wheel":"wheel";
            RecordInput(false);
        }
    }
    public static void RecordKey(uint key,bool down,bool injected=false) {
        if(key==0x1B) {if(down)RecordInput(true);return;}
        lastInputKind=injected?"injected keyboard":"keyboard";
        lock(inputLock) {if(down)heldKeys.Add(key);else heldKeys.Remove(key);}
        RecordInput(false);
    }
    static IntPtr OnMouse(int code,IntPtr message,IntPtr data) {
        if(code>=0 && Current()) {
            var value=(Mouse)Marshal.PtrToStructure(data,typeof(Mouse));
            if(ExternalInput(value.Flags,value.Extra.ToUInt64())) {
                RecordMouse(message.ToInt64(),(value.Flags&1)!=0);
            }
        }
        return CallNextHookEx(IntPtr.Zero,code,message,data);
    }
    static IntPtr OnKey(int code,IntPtr message,IntPtr data) {
        long kind=message.ToInt64();
        if(code>=0 && Current() && (kind==0x100||kind==0x104||kind==0x101||kind==0x105)) {
            var value=(Key)Marshal.PtrToStructure(data,typeof(Key));
            if(ExternalInput(value.Flags,value.Extra.ToUInt64()))RecordKey(value.Vk,kind==0x100||kind==0x104,(value.Flags&16)!=0);
        }
        return CallNextHookEx(IntPtr.Zero,code,message,data);
    }
    public static void Begin(string path,string expected) {
        if(directory!=(path??"") || identity!=(expected??"")) {
            identity="";directory=path??"";identity=expected??"";
            observedVersion=Interlocked.Read(ref inputVersion);
            lock(inputLock) {heldButtons=0;heldKeys.Clear();}
        }
        if(identity.Length>0 && thread==null) {
            thread=new Thread(delegate() {
                try {
                    if(SetWindowsHookEx(14,MouseHandler,GetModuleHandle(null),0)==IntPtr.Zero || SetWindowsHookEx(13,KeyHandler,GetModuleHandle(null),0)==IntPtr.Zero)throw new Win32Exception();
                } catch(Exception error) {hookError=error;} finally {Ready.Set();}
                if(hookError!=null)return;
                Message msg;while(GetMessage(out msg,IntPtr.Zero,0,0)){TranslateMessage(ref msg);DispatchMessage(ref msg);}
            });thread.IsBackground=true;thread.Start();
        }
        if(identity.Length>0 && (!Ready.WaitOne(2000) || hookError!=null))throw new InvalidOperationException("Desktop takeover monitoring unavailable; no action dispatched",hookError);
        if(mutex==null)mutex=new Mutex(false,"Local\\CodeBuddyDesktopInput-"+System.Security.Principal.WindowsIdentity.GetCurrent().User.Value);
        try {ownsMutex=mutex.WaitOne(0);}catch(AbandonedMutexException){ownsMutex=true;Takeover("owner_lost");}
        if(!ownsMutex)throw new InvalidOperationException("Desktop input is busy in another CodeBuddy process");
        CheckLease();
    }
    static void CheckLease() {
        if(identity.Length>0 && !Current())throw new InvalidOperationException("DESKTOP_PAUSED: Desktop control paused or lease changed. No further input; explicit user resume and fresh observation required.");
    }
    public static bool Prepare(bool observation) {
        // A brief input burst needs a fresh observation, not a failed action.
        // The caller must return that observation without replaying old input.
        var deadline=DateTime.UtcNow.AddSeconds(3);
        while(identity.Length>0 && InputActive()) {
            CheckLease();
            if(DateTime.UtcNow>=deadline)throw new DesktopInputConflictException("DESKTOP_INPUT_CONFLICT: Input is still active ("+lastInputKind+"). No new action dispatched; let the user finish interacting before continuing desktop work. Independent work can continue.");
            Thread.Sleep(25);
        }
        CheckLease();
        if(observation) observedVersion=Interlocked.Read(ref inputVersion);
        return identity.Length==0 || observedVersion==Interlocked.Read(ref inputVersion);
    }
    static bool InputActive() {
        lock(inputLock) {
            return heldButtons!=0||heldKeys.Count>0||DateTime.UtcNow.Ticks-Interlocked.Read(ref lastInputTicks)<TimeSpan.TicksPerMillisecond*600;
        }
    }
    public static void Check() {
        CheckLease();
        if(identity.Length>0 && observedVersion!=Interlocked.Read(ref inputVersion))
            throw new DesktopInputConflictException("DESKTOP_INPUT_CONFLICT: Desktop input changed since observation ("+lastInputKind+"). No further input dispatched; an in-flight action may be partial. Observe the target again and reconcile its state before deciding the next action. This is not a persistent pause.");
    }
    public static void EndOperation() {if(ownsMutex){ownsMutex=false;mutex.ReleaseMutex();}}
}
