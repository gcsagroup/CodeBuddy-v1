using System;
using System.ComponentModel;
using System.IO;
using System.Runtime.InteropServices;
using System.Security.AccessControl;
using System.Security.Principal;
using System.Text;
using System.Threading;
using Microsoft.Win32.SafeHandles;

// The caller already owns the folder and can write files and its DACL. The
// Windows runner additionally needs WRITE_OWNER to set its mandatory label.
public static class WorkspaceLabelAccess
{
    const uint ReadControl = 0x20000, WriteDac = 0x40000, WriteOwner = 0x80000;
    const uint AddFileAndDirectory = 6, ShareAll = 7, OpenExisting = 3;
    const uint DirectoryNoFollow = 0x02000000 | 0x00200000;
    const uint OwnerAndDacl = 5, DaclOnly = 4, FileObject = 1;

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    static extern SafeFileHandle CreateFileW(string path, uint access, uint share, IntPtr security, uint creation, uint flags, IntPtr template);
    [StructLayout(LayoutKind.Sequential)]
    struct IoStatus { public IntPtr Status; public UIntPtr Information; }
    [DllImport("ntdll.dll")]
    static extern int NtQueryInformationFile(SafeFileHandle file, out IoStatus io, out uint access, uint size, int infoClass);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    static extern uint GetFinalPathNameByHandleW(SafeFileHandle file, StringBuilder path, int size, uint flags);
    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool GetFileInformationByHandleEx(SafeFileHandle file, int infoClass, out AttributeTag tag, int size);
    [StructLayout(LayoutKind.Sequential)]
    struct AttributeTag { public FileAttributes Attributes; public uint Tag; }
    [DllImport("advapi32.dll")]
    static extern uint GetSecurityInfo(SafeFileHandle file, uint type, uint info, out IntPtr owner, IntPtr group, out IntPtr acl, IntPtr sacl, out IntPtr descriptor);
    [DllImport("advapi32.dll")]
    static extern uint GetSecurityDescriptorLength(IntPtr descriptor);
    [DllImport("ntdll.dll")]
    static extern int NtSetSecurityObject(SafeFileHandle file, uint info, byte[] descriptor);
    [DllImport("ntdll.dll")]
    static extern uint RtlNtStatusToDosError(int status);
    [DllImport("kernel32.dll")]
    static extern IntPtr LocalFree(IntPtr memory);

    public static bool Prepare(string path)
    {
        path = Path.GetFullPath(path).TrimEnd('\\');
        if (path.Length < 4 || path[1] != ':' || path[2] != '\\') return false;
        using (var identity = WindowsIdentity.GetCurrent())
        using (var mutex = new Mutex(false, @"Local\CodeBuddy.WorkspaceLabel." + identity.User.Value))
        {
            try { if (!mutex.WaitOne(5000)) throw new TimeoutException("Workspace ACL is busy"); }
            catch (AbandonedMutexException) { /* Reread the descriptor under the acquired lock. */ }
            try { return PrepareOwnedDirectory(path, identity.User); }
            finally { mutex.ReleaseMutex(); }
        }
    }

    static bool PrepareOwnedDirectory(string path, SecurityIdentifier user)
    {
        // MAXIMUM_ALLOWED also requests DELETE, which conflicts with an active cwd handle.
        using (var handle = CreateFileW(@"\\?\" + path, ReadControl | WriteDac | AddFileAndDirectory, ShareAll, IntPtr.Zero, OpenExisting, DirectoryNoFollow, IntPtr.Zero))
        {
            if (handle.IsInvalid) return false;
            AttributeTag tag;
            if (!GetFileInformationByHandleEx(handle, 9, out tag, 8)) throw new Win32Exception();
            if ((tag.Attributes & (FileAttributes.Directory | FileAttributes.ReparsePoint)) != FileAttributes.Directory) return false;
            var name = new StringBuilder(32768);
            uint length = GetFinalPathNameByHandleW(handle, name, name.Capacity, 0);
            if (length == 0 || length >= name.Capacity || !String.Equals(name.ToString(), @"\\?\" + path, StringComparison.OrdinalIgnoreCase)) return false;
            // FileAccessInformation reports the rights actually granted to this handle.
            IoStatus io;
            uint granted;
            if (NtQueryInformationFile(handle, out io, out granted, sizeof(uint), 8) != 0) return false;
            const uint required = ReadControl | WriteDac | AddFileAndDirectory;
            if ((granted & required) != required) return false;

            IntPtr owner, acl, descriptor;
            uint status = GetSecurityInfo(handle, FileObject, OwnerAndDacl, out owner, IntPtr.Zero, out acl, IntPtr.Zero, out descriptor);
            if (status != 0) throw new Win32Exception((int)status);
            try
            {
                if (owner == IntPtr.Zero || acl == IntPtr.Zero || !user.Equals(new SecurityIdentifier(owner))) return false;
                if ((granted & WriteOwner) != 0) return true;
                var bytes = new byte[(ushort)Marshal.ReadInt16(acl, 2)];
                Marshal.Copy(acl, bytes, 0, bytes.Length);
                var entries = new RawAcl(bytes, 0);
                int position = entries.Count;
                bool alreadyGranted = false;
                for (int i = 0; i < entries.Count; i++)
                {
                    var ace = entries[i] as QualifiedAce;
                    if (ace == null) return false;
                    // Adding an explicit allow must never override an inherited deny.
                    if (ace.AceQualifier == AceQualifier.AccessDenied && (ace.AccessMask & (WriteOwner | 0x10000000)) != 0) return false;
                    if (ace.AceQualifier == AceQualifier.AccessAllowed && user.Equals(ace.SecurityIdentifier)
                        && (ace.AceFlags & AceFlags.InheritOnly) == 0 && (ace.AccessMask & WriteOwner) != 0) alreadyGranted = true;
                    if (entries[i].IsInherited && position == entries.Count) position = i;
                }
                if (alreadyGranted) return true;
                entries.InsertAce(position, new CommonAce(AceFlags.None, AceQualifier.AccessAllowed, (int)WriteOwner, user, false, null));
                var descriptorBytes = new byte[GetSecurityDescriptorLength(descriptor)];
                Marshal.Copy(descriptor, descriptorBytes, 0, descriptorBytes.Length);
                var security = new RawSecurityDescriptor(descriptorBytes, 0);
                security.DiscretionaryAcl = entries;
                var updated = new byte[security.BinaryLength];
                security.GetBinaryForm(updated, 0);
                // Set only this pinned object's DACL; SetSecurityInfo walks existing children.
                int result = NtSetSecurityObject(handle, DaclOnly, updated);
                if (result != 0) throw new Win32Exception((int)RtlNtStatusToDosError(result));
                return true;
            }
            finally { LocalFree(descriptor); }
        }
    }
}
