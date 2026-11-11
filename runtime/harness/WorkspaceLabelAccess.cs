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
    [DllImport("advapi32.dll", EntryPoint = "GetSecurityInfo")]
    static extern uint GetSecurityWithLabel(SafeFileHandle file, uint type, uint info, out IntPtr owner, IntPtr group, out IntPtr acl, out IntPtr sacl, out IntPtr descriptor);
    [DllImport("advapi32.dll")]
    static extern uint GetSecurityDescriptorLength(IntPtr descriptor);
    [DllImport("ntdll.dll")]
    static extern int NtSetSecurityObject(SafeFileHandle file, uint info, byte[] descriptor);
    [DllImport("ntdll.dll")]
    static extern uint RtlNtStatusToDosError(int status);
    [DllImport("kernel32.dll")]
    static extern IntPtr LocalFree(IntPtr memory);
    [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    static extern bool ConvertStringSecurityDescriptorToSecurityDescriptorW(string sddl, uint revision, out IntPtr descriptor, out uint size);
    [StructLayout(LayoutKind.Sequential)]
    struct FileInformation
    {
        public uint Attributes;
        public System.Runtime.InteropServices.ComTypes.FILETIME Creation, Access, Write;
        public uint Volume, SizeHigh, SizeLow, Links, IndexHigh, IndexLow;
    }
    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool GetFileInformationByHandle(SafeFileHandle file, out FileInformation information);

    // Run before restricted execution, including files written by host tools
    // since the preceding command. No-follow, non-delete-sharing handles pin
    // every ancestor during traversal. Never follow junctions or hard links.
    public static int PrepareExisting(string root)
    {
        root = Path.GetFullPath(root).TrimEnd('\\');
        if (root.Length < 4 || root[1] != ':' || root[2] != '\\') return 0;
        using (var identity = WindowsIdentity.GetCurrent())
        using (var mutex = new Mutex(false, @"Local\CodeBuddy.WorkspaceLabel." + identity.User.Value))
        {
            try { if (!mutex.WaitOne(5000)) throw new TimeoutException("Workspace ACL is busy"); }
            catch (AbandonedMutexException) { }
            try { return LabelExisting(root, identity.User, true); }
            finally { mutex.ReleaseMutex(); }
        }
    }

    static int LabelExisting(string path, SecurityIdentifier user, bool root)
    {
        using (var handle = CreateFileW(@"\\?\" + path, ReadControl | WriteDac | 2, 3, IntPtr.Zero, OpenExisting, DirectoryNoFollow, IntPtr.Zero))
        {
            if (handle.IsInvalid) return 0;
            FileInformation info;
            if (!GetFileInformationByHandle(handle, out info)) return 0;
            if ((info.Attributes & (uint)(FileAttributes.ReparsePoint | FileAttributes.ReadOnly)) != 0 || info.Links > 1) return 0;
            var name = new StringBuilder(32768);
            uint length = GetFinalPathNameByHandleW(handle, name, name.Capacity, 0);
            if (length == 0 || length >= name.Capacity || !String.Equals(name.ToString(), @"\\?\" + path, StringComparison.OrdinalIgnoreCase)) return 0;
            IntPtr owner, acl, sacl, descriptor;
            uint status = GetSecurityWithLabel(handle, FileObject, OwnerAndDacl | 16, out owner, IntPtr.Zero, out acl, out sacl, out descriptor);
            if (status != 0) return 0;
            int changed = 0;
            try
            {
                if (owner == IntPtr.Zero || acl == IntPtr.Zero || !user.Equals(new SecurityIdentifier(owner))) return 0;
                var bytes = new byte[GetSecurityDescriptorLength(descriptor)];
                Marshal.Copy(descriptor, bytes, 0, bytes.Length);
                var security = new RawSecurityDescriptor(bytes, 0);
                if (!root && (security.ControlFlags & ControlFlags.DiscretionaryAclProtected) != 0) return 0;
                foreach (GenericAce entry in security.DiscretionaryAcl)
                {
                    var ace = entry as QualifiedAce;
                    if (ace == null || ace.AceQualifier == AceQualifier.AccessDenied &&
                        (ace.AccessMask & (WriteOwner | WriteDac | 2 | 0x10000000 | 0x40000000)) != 0) return 0;
                }
                // Existing explicit labels are protected policy, not a missing label.
                if (!root && (security.SystemAcl == null || security.SystemAcl.Count == 0))
                {
                    // NtSetSecurityObject requires both inheritance bits to
                    // retain AUTO_INHERITED; unlike SetSecurityInfo it does not
                    // walk children. Keep the original ACL and its control state.
                    if ((security.ControlFlags & ControlFlags.DiscretionaryAclAutoInherited) != 0)
                        security.SetFlags(security.ControlFlags | ControlFlags.DiscretionaryAclAutoInheritRequired);
                    var originalDacl = new byte[security.BinaryLength];
                    security.GetBinaryForm(originalDacl, 0);
                    var entries = security.DiscretionaryAcl;
                    int position = 0;
                    while (position < entries.Count && !entries[position].IsInherited) position++;
                    entries.InsertAce(position, new CommonAce(AceFlags.None, AceQualifier.AccessAllowed, (int)WriteOwner, user, false, null));
                    var temporary = new byte[security.BinaryLength];
                    security.GetBinaryForm(temporary, 0);
                    // Ownership alone grants WRITE_DAC, not WRITE_OWNER. Borrow
                    // only label access and restore this exact object's DACL.
                    int result = NtSetSecurityObject(handle, DaclOnly, temporary);
                    if (result != 0) return 0;
                    try
                    {
                        using (var labelHandle = CreateFileW(@"\\?\" + path, WriteOwner, 3, IntPtr.Zero, OpenExisting, DirectoryNoFollow, IntPtr.Zero))
                        {
                            if (labelHandle.IsInvalid) return 0;
                            IntPtr low; uint size;
                            // No inheritance flags: never propagate through skipped children.
                            if (!ConvertStringSecurityDescriptorToSecurityDescriptorW("S:(ML;;NW;;;LW)", 1, out low, out size)) throw new Win32Exception();
                            try
                            {
                                var label = new byte[size]; Marshal.Copy(low, label, 0, label.Length);
                                result = NtSetSecurityObject(labelHandle, 16, label);
                                if (result != 0) throw new Win32Exception((int)RtlNtStatusToDosError(result));
                                changed++;
                            }
                            finally { LocalFree(low); }
                        }
                    }
                    finally
                    {
                        result = NtSetSecurityObject(handle, DaclOnly, originalDacl);
                        if (result != 0) throw new Win32Exception((int)RtlNtStatusToDosError(result));
                    }
                }
            }
            finally { LocalFree(descriptor); }
            if ((info.Attributes & (uint)FileAttributes.Directory) != 0)
            {
                try
                {
                    foreach (string child in Directory.EnumerateFileSystemEntries(path)) changed += LabelExisting(child, user, false);
                }
                catch (UnauthorizedAccessException) { /* Leave inaccessible subtrees untouched. */ }
            }
            return changed;
        }
    }

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
