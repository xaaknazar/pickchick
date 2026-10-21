using System;
using System.Collections.Generic;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
using Microsoft.Win32.SafeHandles;

// Dedicated photo USB device only. No spooler, files containing photos, default printer,
// driver installation, reset command or retry after a partial transfer.
public static class UsbPrinter {
    static Guid printerClass = new Guid("28d78fad-5a12-11d1-ae5b-0000f803a8c2");
    [StructLayout(LayoutKind.Sequential)] struct InterfaceData {
        public int cbSize; public Guid classGuid; public int flags; public IntPtr reserved;
    }
    [DllImport("setupapi.dll", CharSet=CharSet.Unicode, SetLastError=true)]
    static extern IntPtr SetupDiGetClassDevs(ref Guid guid, string enumerator, IntPtr parent, uint flags);
    [DllImport("setupapi.dll", SetLastError=true)]
    static extern bool SetupDiEnumDeviceInterfaces(IntPtr list, IntPtr device, ref Guid guid, uint index, ref InterfaceData data);
    [DllImport("setupapi.dll", CharSet=CharSet.Unicode, SetLastError=true)]
    static extern bool SetupDiGetDeviceInterfaceDetail(IntPtr list, ref InterfaceData data, IntPtr detail, uint size, out uint needed, IntPtr device);
    [DllImport("setupapi.dll")] static extern bool SetupDiDestroyDeviceInfoList(IntPtr list);
    [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)]
    static extern SafeFileHandle CreateFile(string name, uint access, uint share, IntPtr security, uint creation, uint flags, IntPtr template);
    [DllImport("kernel32.dll", SetLastError=true)]
    static extern bool DeviceIoControl(SafeFileHandle handle, uint code, IntPtr input, uint inputLength, byte[] output, uint length, out uint returned, IntPtr overlapped);
    [DllImport("kernel32.dll", SetLastError=true)]
    static extern bool WriteFile(SafeFileHandle handle, byte[] bytes, uint length, out uint written, IntPtr overlapped);

    static List<string> Paths() {
        var result = new List<string>();
        IntPtr list = SetupDiGetClassDevs(ref printerClass, null, IntPtr.Zero, 0x12); // PRESENT | DEVICEINTERFACE
        if (list == new IntPtr(-1)) throw new IOException("USB discovery failed");
        try {
            for (uint i=0; ; i++) {
                var data = new InterfaceData(); data.cbSize = Marshal.SizeOf(typeof(InterfaceData));
                if (!SetupDiEnumDeviceInterfaces(list, IntPtr.Zero, ref printerClass, i, ref data)) {
                    if (Marshal.GetLastWin32Error() != 259) throw new IOException("USB enumeration failed");
                    break;
                }
                uint size;
                SetupDiGetDeviceInterfaceDetail(list, ref data, IntPtr.Zero, 0, out size, IntPtr.Zero);
                if (size < 8 || size > 32768) throw new IOException("Invalid USB interface size");
                IntPtr detail = Marshal.AllocHGlobal((int)size);
                try {
                    Marshal.WriteInt32(detail, IntPtr.Size == 8 ? 8 : 6);
                    if (!SetupDiGetDeviceInterfaceDetail(list, ref data, detail, size, out size, IntPtr.Zero)) throw new IOException("USB detail failed");
                    result.Add(Marshal.PtrToStringUni(IntPtr.Add(detail, 4)));
                } finally { Marshal.FreeHGlobal(detail); }
            }
        } finally { SetupDiDestroyDeviceInfoList(list); }
        return result;
    }
    static SafeFileHandle Open(string path) {
        // Exclusive access: a competing receipt spooler must not interleave with photos.
        return CreateFile(path, 0xC0000000, 0, IntPtr.Zero, 3, 0, IntPtr.Zero);
    }
    static string Identity(SafeFileHandle handle) {
        var data = new byte[1024]; uint count;
        if (handle.IsInvalid || !DeviceIoControl(handle, 0x220034, IntPtr.Zero, 0, data, (uint)data.Length, out count, IntPtr.Zero) || count < 3) return "";
        return Encoding.ASCII.GetString(data, 2, (int)Math.Min(count, (uint)data.Length)-2).TrimEnd('\0');
    }
    static bool Escpos(string identity) {
        return System.Text.RegularExpressions.Regex.IsMatch(identity, @"(?:^|;)\s*(?:CMD|COMMAND SET):[^;]*ESC/POS(?:[,;]|$)", System.Text.RegularExpressions.RegexOptions.IgnoreCase);
    }
    static string Json(string value) {
        return "\"" + value.Replace("\\", "\\\\").Replace("\"", "\\\"").Replace("\r", "\\r").Replace("\n", "\\n").Replace("\t", "\\t") + "\"";
    }
    public static int Main(string[] args) {
        bool attempted = false;
        try {
            if (args.Length == 1 && args[0] == "list") {
                var entries = new List<string>();
                foreach (string path in Paths()) using (var handle = Open(path)) {
                    var identity = Identity(handle);
                    if (Escpos(identity)) entries.Add("{\"path\":" + Json(path) + "}");
                }
                Console.WriteLine("[" + String.Join(",", entries.ToArray()) + "]"); return 0;
            }
            if (args.Length != 2 || args[0] != "send" || !Paths().Contains(args[1])) throw new IOException("Destination not present");
            using (var handle = Open(args[1])) {
                if (!Escpos(Identity(handle))) throw new IOException("Destination not ESC/POS");
                // Read the bounded raster into memory; no disk or Windows spool jobs.
                using (var memory = new MemoryStream()) using (var input = Console.OpenStandardInput()) {
                    var block = new byte[4096]; int count;
                    while ((count = input.Read(block, 0, block.Length)) > 0) {
                        if (memory.Length + count > 524288) throw new IOException("Raster too large");
                        memory.Write(block, 0, count);
                    }
                    if (memory.Length == 0) throw new IOException("Empty raster");
                    byte[] bytes = memory.ToArray();
                    try {
                        for (int offset=0; offset<bytes.Length; offset+=1024) {
                            int length = Math.Min(1024, bytes.Length-offset);
                            var burst = new byte[length]; Array.Copy(bytes, offset, burst, 0, length);
                            uint written; attempted = true;
                            try {
                                if (!WriteFile(handle, burst, (uint)length, out written, IntPtr.Zero) || written != length) throw new IOException("Incomplete transfer");
                            } finally { Array.Clear(burst, 0, burst.Length); }
                            if (offset+length < bytes.Length) Thread.Sleep(40);
                        }
                    } finally { Array.Clear(bytes, 0, bytes.Length); Array.Clear(memory.GetBuffer(), 0, (int)memory.Length); }
                }
            }
            Console.WriteLine("sent"); return 0;
        } catch {
            Console.WriteLine(attempted ? "unknown" : "failed"); return 1;
        }
    }
}
