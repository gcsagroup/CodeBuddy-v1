using System;
using System.Diagnostics;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.Drawing.Imaging;
using System.Runtime.InteropServices;
using System.Threading;
using System.Windows.Forms;

// Presentation only: this worker never activates windows or dispatches input.
// Keep one latest frame, not a queue of animations that can outlive the action.
public static class OcuFeedback {
    const int Wake = 0x8001;
    static readonly object Gate = new object();
    static Frame latest;
    static IntPtr receiver;
    static bool started, wakePending;
    static long generation;
    static readonly Stopwatch Clock = Stopwatch.StartNew();
    public sealed class Frame {
        public long Id, At;
        public string Kind, Label;
        public int X, Y;
        public bool Pointer, Active, Failed;
    }
    [DllImport("user32.dll")] static extern bool PostMessage(IntPtr window, int message, IntPtr w, IntPtr l);
    [DllImport("user32.dll")] static extern IntPtr SetThreadDpiAwarenessContext(IntPtr context);
    [StructLayout(LayoutKind.Sequential)] struct CursorPoint { public int X,Y; }
    [DllImport("user32.dll")] static extern bool GetCursorPos(out CursorPoint point);

    public static long Begin(string kind, int x, int y, bool pointer) {
        if (Environment.GetEnvironmentVariable("CODEBUDDY_DESKTOP_FEEDBACK") == "0") return 0;
        var frame = new Frame { Id=Interlocked.Increment(ref generation), At=Clock.ElapsedMilliseconds,
            Kind=kind, Label=Label(kind, true), X=x, Y=y, Pointer=pointer, Active=true };
        Publish(frame);
        return frame.Id;
    }
    public static void End(long id, bool failed) {
        if (id==0) return;
        lock(Gate) {
            if (latest==null || latest.Id!=id) return;
            latest = Complete(latest,id,failed,Clock.ElapsedMilliseconds);
            CursorPoint cursor;
            if(latest.Kind=="drag" && GetCursorPos(out cursor)) {latest.X=cursor.X;latest.Y=cursor.Y;}
            WakeWorker();
        }
    }
    public static Frame Complete(Frame current,long id,bool failed,long at) {
        if(current==null || current.Id!=id) return current;
        return new Frame { Id=id, At=at, Kind=current.Kind,
            Label=failed ? "本次操作未完成" : Label(current.Kind,false), X=current.X, Y=current.Y,
            Pointer=current.Pointer, Failed=failed };
    }
    public static string Label(string kind, bool active) {
        switch(kind) {
            case "click": return active ? "正在点击" : "点击已发出";
            case "right_click": return active ? "正在右键点击" : "右键已发出";
            case "double_click": return active ? "正在双击" : "双击已发出";
            case "drag": return active ? "正在拖动" : "拖动已发出";
            case "scroll_up": return active ? "正在向上滚动" : "滚动已发出";
            case "scroll_down": return active ? "正在向下滚动" : "滚动已发出";
            case "scroll_left": return active ? "正在向左滚动" : "滚动已发出";
            case "scroll_right": return active ? "正在向右滚动" : "滚动已发出";
            case "type_text": case "set_value": return active ? "正在输入" : "输入已发出";
            case "press_key": return active ? "正在按键" : "按键已发出";
            case "get_app_state": case "list_apps": return active ? "正在查看界面" : "界面已读取";
            case "open_path": return active ? "正在打开" : "打开请求已发出";
            default: return active ? "正在操作界面" : "操作已发出";
        }
    }
    static void Publish(Frame frame) {
        try {
            lock(Gate) {
                latest=frame;
                WakeWorker();
                if(started) return;
                started=true;
                var thread=new Thread(delegate() {
                    try {
                        SetThreadDpiAwarenessContext(new IntPtr(-4));
                        using(var overlay=new Overlay()) {
                            lock(Gate) { receiver=overlay.Handle; WakeWorker(); }
                            Application.Run();
                        }
                    } catch { /* Optional visuals must not fail or replay an input. */ }
                    finally { lock(Gate) {receiver=IntPtr.Zero;wakePending=false;} }
                });
                thread.IsBackground=true;
                thread.SetApartmentState(ApartmentState.STA);
                thread.Start();
            }
        } catch { }
    }
    // Called with Gate held. Coalesce notifications as well as frame data.
    static void WakeWorker() {
        if(receiver!=IntPtr.Zero && !wakePending)
            wakePending=PostMessage(receiver,Wake,IntPtr.Zero,IntPtr.Zero);
    }
    sealed class Overlay : Form {
        readonly System.Windows.Forms.Timer timer=new System.Windows.Forms.Timer();
        bool excluded, reduced;
        [StructLayout(LayoutKind.Sequential)] struct P { public int X,Y; public P(int x,int y){X=x;Y=y;} }
        [StructLayout(LayoutKind.Sequential)] struct S { public int W,H; public S(int w,int h){W=w;H=h;} }
        [StructLayout(LayoutKind.Sequential,Pack=1)] struct Blend {public byte Op,Flags,Alpha,Format;}
        [DllImport("user32.dll")] static extern bool GetCursorPos(out P point);
        [DllImport("user32.dll")] static extern bool ShowWindow(IntPtr window,int command);
        [DllImport("user32.dll")] static extern bool SetWindowDisplayAffinity(IntPtr h,uint affinity);
        [DllImport("user32.dll")] static extern bool SystemParametersInfo(uint action,uint param,out bool value,uint flags);
        [DllImport("user32.dll")] static extern IntPtr GetDC(IntPtr h);
        [DllImport("user32.dll")] static extern int ReleaseDC(IntPtr h,IntPtr dc);
        [DllImport("gdi32.dll")] static extern IntPtr CreateCompatibleDC(IntPtr dc);
        [DllImport("gdi32.dll")] static extern IntPtr SelectObject(IntPtr dc,IntPtr obj);
        [DllImport("gdi32.dll")] static extern bool DeleteObject(IntPtr obj);
        [DllImport("gdi32.dll")] static extern bool DeleteDC(IntPtr dc);
        [DllImport("user32.dll")] static extern bool UpdateLayeredWindow(IntPtr h,IntPtr screen,ref P pos,ref S size,IntPtr source,ref P zero,uint key,ref Blend blend,uint flags);
        [DllImport("user32.dll")] static extern bool SetWindowPos(IntPtr h,IntPtr after,int x,int y,int w,int height,uint flags);
        protected override bool ShowWithoutActivation { get { return true; } }
        protected override CreateParams CreateParams { get {
            var p=base.CreateParams;
            p.ExStyle |= 0x08000000 | 0x00080000 | 0x00000020 | 0x00000080; // no activate, layered, pass-through, tool
            return p;
        } }
        public Overlay() {
            FormBorderStyle=FormBorderStyle.None; ShowInTaskbar=false; Text="CodeBuddy 操作提示";
            timer.Interval=33;
            timer.Tick += delegate { SafeDraw(); };
        }
        protected override void OnHandleCreated(EventArgs e) {
            base.OnHandleCreated(e);
            // Unsupported capture exclusion degrades to no overlay, never black capture pixels.
            excluded=Environment.OSVersion.Version.Build>=19041 && SetWindowDisplayAffinity(Handle,0x11);
            bool animation;
            reduced=SystemParametersInfo(0x1042,0,out animation,0) && !animation;
        }
        protected override void WndProc(ref Message m) {
            if(m.Msg==Wake) { lock(Gate) wakePending=false; timer.Start(); SafeDraw(); return; }
            if(m.Msg==0x21) {m.Result=new IntPtr(3);return;} // MA_NOACTIVATE
            if(m.Msg==0x84) {m.Result=new IntPtr(-1);return;} // HTTRANSPARENT
            base.WndProc(ref m);
        }
        void SafeDraw() {
            try { DrawFrame(); } catch { Conceal(); }
        }
        void Conceal() {ShowWindow(Handle,0);timer.Stop();}
        void DrawFrame() {
            Frame frame;
            lock(Gate) frame=latest;
            if(frame==null || !excluded || !frame.Pointer) {Conceal();return;}
            long age=Clock.ElapsedMilliseconds-frame.At;
            // The input watchdog owns failure. An animation lease never declares completion.
            int lifetime=frame.Active?30000:850;
            if(age>=lifetime) {Conceal();return;}
            int x=frame.X,y=frame.Y;
            if(frame.Kind=="drag" && frame.Active) {P cursor;if(GetCursorPos(out cursor)){x=cursor.X;y=cursor.Y;}}
            var screen=Screen.FromPoint(new Point(x,y));
            bool pointer=frame.Pointer && screen.Bounds.Contains(x,y);
            // Rejected/stale coordinates must not allocate an enormous surface.
            x=Math.Max(screen.Bounds.Left,Math.Min(x,screen.Bounds.Right-1));
            y=Math.Max(screen.Bounds.Top,Math.Min(y,screen.Bounds.Bottom-1));
            // The host owns the top control banner. Keep the native surface tiny:
            // no card beside the input target, and no desktop-sized bitmap.
            var bounds=new Rectangle(x-42,y-42,84,84);
            using(var bitmap=new Bitmap(bounds.Width,bounds.Height,PixelFormat.Format32bppArgb))
            using(var g=Graphics.FromImage(bitmap)) {
                g.SmoothingMode=SmoothingMode.AntiAlias;
                g.TextRenderingHint=System.Drawing.Text.TextRenderingHint.AntiAliasGridFit;
                var accent=frame.Failed?Color.FromArgb(245,158,66):frame.Kind=="right_click"?Color.FromArgb(168,139,250):Color.FromArgb(59,180,255);
                int px=x-bounds.X,py=y-bounds.Y;
                if(pointer) {
                    using(var glow=new GraphicsPath()) {
                        glow.AddEllipse(px-34,py-34,68,68);
                        using(var brush=new PathGradientBrush(glow)) {
                            brush.CenterColor=Color.FromArgb(90,accent);brush.SurroundColors=new Color[]{Color.FromArgb(0,accent)};
                            g.FillPath(brush,glow);
                        }
                    }
                    float phase=reduced?0.35f:(age%650)/650f;
                    float r=14+22*phase;
                    using(var pen=new Pen(Color.FromArgb((int)(180*(1-phase)),accent),2)) g.DrawEllipse(pen,px-r,py-r,r*2,r*2);
                    using(var pen=new Pen(Color.FromArgb(210,accent),2)) g.DrawEllipse(pen,px-8,py-8,16,16);
                    if(frame.Kind=="double_click") using(var pen=new Pen(Color.FromArgb(120,accent),1.5f)) g.DrawEllipse(pen,px-r-6,py-r-6,(r+6)*2,(r+6)*2);
                    if(frame.Kind.StartsWith("scroll_")) {
                        int dx=frame.Kind=="scroll_left"?-1:frame.Kind=="scroll_right"?1:0;
                        int dy=frame.Kind=="scroll_up"?-1:frame.Kind=="scroll_down"?1:0;
                        using(var pen=new Pen(accent,3)) {pen.EndCap=LineCap.ArrowAnchor;g.DrawLine(pen,px-dx*12,py-dy*12,px+dx*16,py+dy*16);}
                    }
                }
                byte alpha=(byte)(frame.Active||reduced?255:255*Math.Min(1,(lifetime-age)/250.0));
                Present(bitmap,bounds,alpha);
            }
        }
        void Present(Bitmap bitmap,Rectangle bounds,byte alpha) {
            IntPtr screen=GetDC(IntPtr.Zero),memory=CreateCompatibleDC(screen),image=IntPtr.Zero,old=IntPtr.Zero;
            try {
                image=bitmap.GetHbitmap(Color.FromArgb(0));old=SelectObject(memory,image);
                var pos=new P(bounds.X,bounds.Y);var zero=new P(0,0);var size=new S(bounds.Width,bounds.Height);
                var blend=new Blend{Alpha=alpha,Format=1};
                UpdateLayeredWindow(Handle,screen,ref pos,ref size,memory,ref zero,0,ref blend,2);
                SetWindowPos(Handle,new IntPtr(-1),0,0,0,0,0x1|0x2|0x10|0x40);
            } finally {
                if(old!=IntPtr.Zero) SelectObject(memory,old);
                if(image!=IntPtr.Zero) DeleteObject(image);
                DeleteDC(memory);ReleaseDC(IntPtr.Zero,screen);
            }
        }
        protected override void Dispose(bool disposing) {
            if(disposing) timer.Dispose();
            base.Dispose(disposing);
        }
    }
}
