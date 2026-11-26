# Sends the ESC/POS bytes on stdin RAW to one Windows printer queue (winspool), then exits.
# Exit codes: 0 = all bytes handed to the spooler, 2 = queue not found / not accepted (nothing
# printed), 3 = written partially or unknown. The photo never touches the disk.
param([Parameter(Mandatory = $true)][string]$Queue)
$ErrorActionPreference = 'Stop'
Add-Type -Language CSharp -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class PickChickRaw {
  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
  public class DOCINFO { public string pDocName; public string pOutputFile; public string pDataType; }
  [DllImport("winspool.drv", CharSet = CharSet.Unicode, SetLastError = true)]
  static extern bool OpenPrinter(string name, out IntPtr handle, IntPtr defaults);
  [DllImport("winspool.drv", SetLastError = true)] static extern bool ClosePrinter(IntPtr handle);
  [DllImport("winspool.drv", CharSet = CharSet.Unicode, SetLastError = true)]
  static extern int StartDocPrinter(IntPtr handle, int level, [In] DOCINFO info);
  [DllImport("winspool.drv", SetLastError = true)] static extern bool EndDocPrinter(IntPtr handle);
  [DllImport("winspool.drv", SetLastError = true)] static extern bool StartPagePrinter(IntPtr handle);
  [DllImport("winspool.drv", SetLastError = true)] static extern bool EndPagePrinter(IntPtr handle);
  [DllImport("winspool.drv", SetLastError = true)]
  static extern bool WritePrinter(IntPtr handle, byte[] bytes, int count, out int written);
  public static int Send(string queue, byte[] data) {
    IntPtr h;
    if (!OpenPrinter(queue, out h, IntPtr.Zero)) return 2;
    try {
      var di = new DOCINFO(); di.pDocName = "PickChick photo"; di.pDataType = "RAW";
      if (StartDocPrinter(h, 1, di) == 0) return 2;
      int written = 0;
      try {
        StartPagePrinter(h);
        if (!WritePrinter(h, data, data.Length, out written) || written != data.Length) return 3;
        EndPagePrinter(h);
      } finally { EndDocPrinter(h); }
      return 0;
    } finally { ClosePrinter(h); }
  }
}
'@
try {
  $stdin = [Console]::OpenStandardInput()
  $buffer = New-Object System.IO.MemoryStream
  $stdin.CopyTo($buffer)
  $bytes = $buffer.ToArray()
  if ($bytes.Length -lt 8) { exit 2 }
  $code = [PickChickRaw]::Send($Queue, $bytes)
  [Array]::Clear($bytes, 0, $bytes.Length)
  exit $code
} catch { exit 3 }
