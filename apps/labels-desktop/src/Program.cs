// PickChick «Маркировка» — standalone Windows program for food labels on the receipt printer.
// .NET Framework 4.x WinForms, written for the C# 5 compiler that ships with Windows
// (C:\Windows\Microsoft.NET\Framework64\v4.0.30319\csc.exe): no string interpolation, no ?. .
// Build: infra/build.ps1. Data (products, settings, journal) lives in <exe folder>\data.

using System;
using System.Collections.Generic;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.Drawing.Imaging;
using System.Drawing.Printing;
using System.Drawing.Text;
using System.Globalization;
using System.IO;
using System.Linq;
using System.Runtime.InteropServices;
using System.Text;
using System.Web.Script.Serialization;
using System.Windows.Forms;

[assembly: System.Reflection.AssemblyTitle("PickChick Маркировка")]
[assembly: System.Reflection.AssemblyProduct("PickChick")]
[assembly: System.Reflection.AssemblyVersion("1.1.0.0")]

namespace PickChick.Labels
{
    // ------------------------------------------------------------------ model

    public class Product
    {
        public string Name { get; set; }
        public string Category { get; set; }
        /// <summary>Shelf life amount in <see cref="Unit"/>.</summary>
        public int Shelf { get; set; }
        /// <summary>"min", "h" or "d".</summary>
        public string Unit { get; set; }
        public string Storage { get; set; }

        public Product() { }
        public Product(string category, string name, int shelf, string unit, string storage)
        {
            Category = category; Name = name; Shelf = shelf; Unit = unit; Storage = storage;
        }

        public DateTime ExpiryFrom(DateTime made)
        {
            switch (Unit)
            {
                case "min": return made.AddMinutes(Shelf);
                case "d": return made.AddDays(Shelf);
                default: return made.AddHours(Shelf);
            }
        }

        public string ShelfText()
        {
            return Shelf + " " + UnitShort(Unit);
        }

        public static string UnitShort(string unit)
        {
            switch (unit)
            {
                case "min": return "мин";
                case "d": return "сут";
                default: return "ч";
            }
        }
    }

    public class Settings
    {
        public string PrinterName { get; set; }
        /// <summary>"escpos" (raster image sent raw to the queue) or "driver" (Windows driver page).</summary>
        public string Mode { get; set; }
        public int PrintWidthMm { get; set; }
        public int LabelHeightMm { get; set; }
        public bool Cut { get; set; }
        /// <summary>Unused since 1.1 (kept so old settings.json still loads).</summary>
        public int FeedMm { get; set; }
        /// <summary>Backing between two die-cut labels; label + gap = paper advanced per label.</summary>
        public int GapMm { get; set; }
        /// <summary>Shift of the print down from the start of each label pitch.</summary>
        public int OffsetYMm { get; set; }
        /// <summary>Shift of the print right from the left edge of the print head.</summary>
        public int OffsetXMm { get; set; }
        public List<string> Employees { get; set; }
        public string LastEmployee { get; set; }

        public Settings()
        {
            PrinterName = "";
            Mode = "escpos";
            PrintWidthMm = 72;
            LabelHeightMm = 40;
            Cut = true;
            FeedMm = 0;
            GapMm = 3;
            OffsetYMm = 0;
            OffsetXMm = 0;
            Employees = new List<string>();
            LastEmployee = "";
        }
    }

    public class JournalEntry
    {
        public DateTime Printed;
        public string Product;
        public DateTime Made;
        public DateTime Until;
        public int Copies;
        public string Employee;
    }

    // ------------------------------------------------------------------ storage

    public static class Store
    {
        public static readonly string AppDir = AppDomain.CurrentDomain.BaseDirectory;
        public static readonly string DataDir = Path.Combine(AppDir, "data");
        static readonly string ProductsPath = Path.Combine(DataDir, "products.json");
        static readonly string SettingsPath = Path.Combine(DataDir, "settings.json");
        static readonly string JournalPath = Path.Combine(DataDir, "journal.csv");
        static readonly UTF8Encoding Utf8Bom = new UTF8Encoding(true);

        static JavaScriptSerializer Json()
        {
            var s = new JavaScriptSerializer();
            s.MaxJsonLength = 16 * 1024 * 1024;
            return s;
        }

        static void WriteAtomic(string path, string text)
        {
            Directory.CreateDirectory(DataDir);
            string tmp = path + ".tmp";
            File.WriteAllText(tmp, text, Utf8Bom);
            if (File.Exists(path))
            {
                string bak = path + ".bak";
                File.Replace(tmp, path, bak);
            }
            else
            {
                File.Move(tmp, path);
            }
        }

        public static List<Product> LoadProducts()
        {
            try
            {
                if (File.Exists(ProductsPath))
                {
                    var list = Json().Deserialize<List<Product>>(File.ReadAllText(ProductsPath, Encoding.UTF8));
                    if (list != null)
                    {
                        foreach (var p in list)
                        {
                            if (p.Unit != "min" && p.Unit != "h" && p.Unit != "d") p.Unit = "h";
                            if (p.Category == null) p.Category = "";
                            if (p.Storage == null) p.Storage = "";
                        }
                        return list.Where(p => !string.IsNullOrWhiteSpace(p.Name) && p.Shelf > 0).ToList();
                    }
                }
            }
            catch (Exception ex)
            {
                MessageBox.Show("Не удалось прочитать список продуктов:\n" + ex.Message +
                    "\n\nОткрыт список по умолчанию. Старый файл сохранён рядом как products.json.broken.",
                    "Маркировка", MessageBoxButtons.OK, MessageBoxIcon.Warning);
                try { File.Copy(ProductsPath, ProductsPath + ".broken", true); } catch { }
            }
            var seed = DefaultProducts();
            SaveProducts(seed);
            return seed;
        }

        public static void SaveProducts(List<Product> products)
        {
            WriteAtomic(ProductsPath, Json().Serialize(products));
        }

        public static Settings LoadSettings()
        {
            try
            {
                if (File.Exists(SettingsPath))
                {
                    var s = Json().Deserialize<Settings>(File.ReadAllText(SettingsPath, Encoding.UTF8));
                    if (s != null)
                    {
                        if (s.Employees == null) s.Employees = new List<string>();
                        if (s.Mode != "driver") s.Mode = "escpos";
                        Normalize(s);
                        if (s.PrinterName == null) s.PrinterName = "";
                        if (s.LastEmployee == null) s.LastEmployee = "";
                        return s;
                    }
                }
            }
            catch { }
            var fresh = new Settings();
            fresh.PrinterName = GuessPrinter();
            SaveSettings(fresh);
            return fresh;
        }

        public static void Normalize(Settings s)
        {
            if (s.PrintWidthMm < 20 || s.PrintWidthMm > 72) s.PrintWidthMm = 72;
            if (s.LabelHeightMm < 15 || s.LabelHeightMm > 200) s.LabelHeightMm = 40;
            if (s.GapMm < 0 || s.GapMm > 30) s.GapMm = 0;
            if (s.OffsetYMm < 0 || s.OffsetYMm > 60) s.OffsetYMm = 0;
            if (s.OffsetXMm < 0 || s.OffsetXMm > 52) s.OffsetXMm = 0;
            if (s.OffsetXMm + s.PrintWidthMm > 72) s.OffsetXMm = 72 - s.PrintWidthMm;
        }

        public static void SaveSettings(Settings s)
        {
            WriteAtomic(SettingsPath, Json().Serialize(s));
        }

        public static string GuessPrinter()
        {
            string[] preferred = { "PickChick XP-A160M", "Xprinter XP-80", "XP-80" };
            var installed = new List<string>();
            foreach (string p in PrinterSettings.InstalledPrinters) installed.Add(p);
            foreach (var want in preferred)
                foreach (var p in installed)
                    if (string.Equals(p, want, StringComparison.OrdinalIgnoreCase)) return p;
            foreach (var p in installed)
                if (p.IndexOf("xp", StringComparison.OrdinalIgnoreCase) >= 0 ||
                    p.IndexOf("xprinter", StringComparison.OrdinalIgnoreCase) >= 0) return p;
            try { return new PrinterSettings().PrinterName; } catch { return ""; }
        }

        static string Csv(string v)
        {
            if (v == null) v = "";
            return "\"" + v.Replace("\"", "\"\"") + "\"";
        }

        const string Stamp = "dd.MM.yyyy HH:mm";

        public static void AppendJournal(JournalEntry e)
        {
            Directory.CreateDirectory(DataDir);
            bool fresh = !File.Exists(JournalPath);
            var line = new StringBuilder();
            if (fresh) line.Append("Напечатано;Продукт;Маркировано;Годен до;Копий;Сотрудник\r\n");
            line.Append(Csv(e.Printed.ToString(Stamp))).Append(';')
                .Append(Csv(e.Product)).Append(';')
                .Append(Csv(e.Made.ToString(Stamp))).Append(';')
                .Append(Csv(e.Until.ToString(Stamp))).Append(';')
                .Append(e.Copies).Append(';')
                .Append(Csv(e.Employee)).Append("\r\n");
            File.AppendAllText(JournalPath, line.ToString(), Utf8Bom);
        }

        public static List<string[]> ReadJournal(int max)
        {
            var rows = new List<string[]>();
            if (!File.Exists(JournalPath)) return rows;
            var lines = File.ReadAllLines(JournalPath, Encoding.UTF8);
            for (int i = lines.Length - 1; i >= 1 && rows.Count < max; i--)
            {
                var cells = SplitCsv(lines[i]);
                if (cells.Count >= 6) rows.Add(cells.ToArray());
            }
            return rows;
        }

        static List<string> SplitCsv(string line)
        {
            var cells = new List<string>();
            var cur = new StringBuilder();
            bool quoted = false;
            for (int i = 0; i < line.Length; i++)
            {
                char c = line[i];
                if (quoted)
                {
                    if (c == '"')
                    {
                        if (i + 1 < line.Length && line[i + 1] == '"') { cur.Append('"'); i++; }
                        else quoted = false;
                    }
                    else cur.Append(c);
                }
                else if (c == '"') quoted = true;
                else if (c == ';') { cells.Add(cur.ToString()); cur.Length = 0; }
                else cur.Append(c);
            }
            cells.Add(cur.ToString());
            return cells;
        }

        public static string JournalFile { get { return JournalPath; } }

        /// <summary>Example list for a fried-chicken kitchen. Shelf lives are starting values only:
        /// the restaurant sets its own from technological cards and sanitary rules.</summary>
        public static List<Product> DefaultProducts()
        {
            const string raw = "Курица сырая", ready = "Готовое", sauce = "Соусы", veg = "Овощи",
                dough = "Тесто и хлеб", other = "Прочее";
            const string cold = "+0…+4 °C", fridge = "+2…+6 °C", hot = "не ниже +65 °C", frozen = "−18 °C", room = "+15…+25 °C";
            return new List<Product>
            {
                new Product(raw, "Куриное филе охлаждённое", 48, "h", cold),
                new Product(raw, "Куриные крылья охлаждённые", 48, "h", cold),
                new Product(raw, "Куриные голени охлаждённые", 48, "h", cold),
                new Product(raw, "Курица в маринаде", 24, "h", cold),
                new Product(raw, "Курица в панировке (заготовка)", 6, "h", cold),
                new Product(raw, "Курица разморожена", 24, "h", cold),
                new Product(ready, "Курица жареная (тепловая витрина)", 2, "h", hot),
                new Product(ready, "Стрипсы жареные", 2, "h", hot),
                new Product(ready, "Крылья жареные", 2, "h", hot),
                new Product(ready, "Картофель фри (после жарки)", 10, "min", hot),
                new Product(ready, "Рис отварной", 12, "h", fridge),
                new Product(sauce, "Соус сырный (вскрыт)", 72, "h", fridge),
                new Product(sauce, "Соус чесночный (свой)", 48, "h", fridge),
                new Product(sauce, "Соус барбекю (вскрыт)", 7, "d", fridge),
                new Product(sauce, "Соус острый (вскрыт)", 7, "d", fridge),
                new Product(sauce, "Кетчуп (вскрыт)", 7, "d", fridge),
                new Product(sauce, "Майонез (вскрыт)", 72, "h", fridge),
                new Product(sauce, "Соус в дозаторе", 24, "h", fridge),
                new Product(veg, "Салат айсберг нарезанный", 24, "h", fridge),
                new Product(veg, "Помидоры нарезанные", 24, "h", fridge),
                new Product(veg, "Огурцы нарезанные", 24, "h", fridge),
                new Product(veg, "Огурцы маринованные (вскрыты)", 72, "h", fridge),
                new Product(veg, "Лук нарезанный", 24, "h", fridge),
                new Product(veg, "Капуста шинкованная", 24, "h", fridge),
                new Product(veg, "Салат коул слоу", 12, "h", fridge),
                new Product(dough, "Тесто для лепёшек", 48, "h", cold),
                new Product(dough, "Кляр", 12, "h", cold),
                new Product(dough, "Панировочная смесь (вскрыта)", 7, "d", room),
                new Product(dough, "Лаваш (вскрыт)", 72, "h", room),
                new Product(dough, "Булочки для бургеров (разморожены)", 48, "h", room),
                new Product(other, "Сыр нарезанный", 72, "h", fridge),
                new Product(other, "Сыр тёртый", 48, "h", fridge),
                new Product(other, "Масло фритюрное (залито)", 3, "d", "в фритюре"),
                new Product(other, "Заготовка в морозилке", 30, "d", frozen),
            };
        }
    }

    // ------------------------------------------------------------------ label image

    public static class LabelRenderer
    {
        public const int DotsPerMm = 8; // 203 dpi thermal head
        const string Stamp = "dd.MM.yyyy  HH:mm";

        public static Bitmap Render(Product p, DateTime made, DateTime until, string employee, Settings s)
        {
            int w = s.PrintWidthMm * DotsPerMm;
            w -= w % 8;
            int h = s.LabelHeightMm * DotsPerMm;
            var bmp = new Bitmap(w, h, PixelFormat.Format24bppRgb);
            bmp.SetResolution(203f, 203f);
            using (var g = Graphics.FromImage(bmp))
            {
                g.Clear(Color.White);
                g.TextRenderingHint = TextRenderingHint.SingleBitPerPixelGridFit;
                g.SmoothingMode = SmoothingMode.None;
                int pad = 2 * DotsPerMm;
                int x = pad, y = DotsPerMm, inner = w - 2 * pad;
                // Scale to the label: 72 x 40 mm (576 x 320 dots) is 1.
                float k = Math.Min(h / 320f, w / 576f);
                if (k > 1.6f) k = 1.6f;
                if (k < 0.45f) k = 0.45f;

                using (var nameFont = FitFont(g, p.Name, "Arial", 34f * k, FontStyle.Bold, inner, (int)(80 * k)))
                {
                    var nameRect = new RectangleF(x, y, inner, 80 * k);
                    var fmt = new StringFormat();
                    fmt.Trimming = StringTrimming.EllipsisWord;
                    g.DrawString(p.Name, nameFont, Brushes.Black, nameRect, fmt);
                    var size = g.MeasureString(p.Name, nameFont, inner, fmt);
                    y += (int)Math.Min(size.Height, 80 * k) + (int)(4 * k);
                }
                g.FillRectangle(Brushes.Black, x, y, inner, Math.Max(2, (int)(3 * k)));
                y += (int)(10 * k);

                using (var small = new Font("Arial", 20f * k, FontStyle.Regular, GraphicsUnit.Pixel))
                using (var smallBold = new Font("Arial", 22f * k, FontStyle.Bold, GraphicsUnit.Pixel))
                using (var big = FitWidth(g, until.ToString(Stamp), "Arial", 42f * k, FontStyle.Bold, inner - 12))
                {
                    g.DrawString("Изготовлено / вскрыто:", small, Brushes.Black, x, y);
                    y += (int)(22 * k);
                    g.DrawString(made.ToString(Stamp), smallBold, Brushes.Black, x, y);
                    y += (int)(32 * k);

                    // Inverted block: the expiry is what the cook reads first.
                    int blockH = (int)(82 * k);
                    g.FillRectangle(Brushes.Black, x, y, inner, blockH);
                    g.DrawString("ГОДЕН ДО:", small, Brushes.White, x + 6, y + 4);
                    g.DrawString(until.ToString(Stamp), big, Brushes.White, x + 6, y + (int)(26 * k));
                    y += blockH + (int)(8 * k);

                    var parts = new List<string>();
                    parts.Add("Срок: " + p.ShelfText());
                    if (!string.IsNullOrWhiteSpace(p.Storage)) parts.Add("Хранить: " + p.Storage);
                    g.DrawString(string.Join("   ", parts.ToArray()), small, Brushes.Black,
                        new RectangleF(x, y, inner, 44 * k));
                    y += (int)(26 * k);
                    if (!string.IsNullOrWhiteSpace(employee) && y + 22 * k <= h)
                    {
                        g.DrawString("Маркировал: " + employee.Trim(), small, Brushes.Black,
                            new RectangleF(x, y, inner, 24 * k));
                    }
                }
            }
            return bmp;
        }

        static Font FitWidth(Graphics g, string text, string family, float start, FontStyle style, int width)
        {
            float size = start;
            while (size > 10f)
            {
                var f = new Font(family, size, style, GraphicsUnit.Pixel);
                if (g.MeasureString(text, f).Width <= width) return f;
                f.Dispose();
                size -= 1f;
            }
            return new Font(family, 10f, style, GraphicsUnit.Pixel);
        }

        /// <summary>The paper of one label: full head width (72 mm) x (label + gap), the label
        /// drawn at the configured offsets. Printing exactly this much per label keeps the
        /// print and the cut in the same place on every die-cut label.</summary>
        public static Bitmap Compose(Bitmap label, Settings s)
        {
            int w = 72 * DotsPerMm;
            int h = (s.LabelHeightMm + s.GapMm) * DotsPerMm;
            var page = new Bitmap(w, h, PixelFormat.Format24bppRgb);
            page.SetResolution(203f, 203f);
            using (var g = Graphics.FromImage(page))
            {
                g.Clear(Color.White);
                g.InterpolationMode = InterpolationMode.NearestNeighbor;
                g.DrawImageUnscaled(label, s.OffsetXMm * DotsPerMm, s.OffsetYMm * DotsPerMm);
            }
            return page;
        }

        static Font FitFont(Graphics g, string text, string family, float start, FontStyle style, int width, int maxHeight)
        {
            float size = start;
            while (size > 12f)
            {
                var f = new Font(family, size, style, GraphicsUnit.Pixel);
                var m = g.MeasureString(text, f, width);
                if (m.Height <= maxHeight) return f;
                f.Dispose();
                size -= 2f;
            }
            return new Font(family, 12f, style, GraphicsUnit.Pixel);
        }
    }

    // ------------------------------------------------------------------ printing

    public static class Printer
    {
        [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
        class DOCINFO
        {
            [MarshalAs(UnmanagedType.LPWStr)] public string pDocName;
            [MarshalAs(UnmanagedType.LPWStr)] public string pOutputFile;
            [MarshalAs(UnmanagedType.LPWStr)] public string pDataType;
        }

        [DllImport("winspool.drv", EntryPoint = "OpenPrinterW", SetLastError = true, CharSet = CharSet.Unicode)]
        static extern bool OpenPrinter(string name, out IntPtr handle, IntPtr defaults);
        [DllImport("winspool.drv", SetLastError = true)]
        static extern bool ClosePrinter(IntPtr handle);
        [DllImport("winspool.drv", EntryPoint = "StartDocPrinterW", SetLastError = true, CharSet = CharSet.Unicode)]
        static extern int StartDocPrinter(IntPtr handle, int level, [In] DOCINFO di);
        [DllImport("winspool.drv", SetLastError = true)]
        static extern bool EndDocPrinter(IntPtr handle);
        [DllImport("winspool.drv", SetLastError = true)]
        static extern bool StartPagePrinter(IntPtr handle);
        [DllImport("winspool.drv", SetLastError = true)]
        static extern bool EndPagePrinter(IntPtr handle);
        [DllImport("winspool.drv", SetLastError = true)]
        static extern bool WritePrinter(IntPtr handle, byte[] bytes, int count, out int written);

        public static void SendRaw(string printer, byte[] data, string docName)
        {
            IntPtr h;
            if (!OpenPrinter(printer, out h, IntPtr.Zero))
                throw new InvalidOperationException("Принтер «" + printer + "» не найден (код " + Marshal.GetLastWin32Error() + ").");
            try
            {
                var di = new DOCINFO();
                di.pDocName = docName;
                di.pDataType = "RAW";
                if (StartDocPrinter(h, 1, di) == 0)
                    throw new InvalidOperationException("Принтер не принял задание (код " + Marshal.GetLastWin32Error() + ").");
                try
                {
                    StartPagePrinter(h);
                    int written;
                    if (!WritePrinter(h, data, data.Length, out written) || written != data.Length)
                        throw new InvalidOperationException("Не удалось передать этикетку на принтер (код " + Marshal.GetLastWin32Error() + ").");
                    EndPagePrinter(h);
                }
                finally { EndDocPrinter(h); }
            }
            finally { ClosePrinter(h); }
        }

        /// <summary>ESC/POS: init, raster image (GS v 0) in bands, optional partial cut in place.</summary>
        public static byte[] EscPos(Bitmap bmp, Settings s)
        {
            var o = new MemoryStream();
            o.WriteByte(0x1B); o.WriteByte(0x40);             // ESC @
            o.WriteByte(0x1B); o.WriteByte(0x61); o.WriteByte(0x00); // left
            int bytesPerRow = bmp.Width / 8;
            const int band = 96;
            for (int top = 0; top < bmp.Height; top += band)
            {
                int rows = Math.Min(band, bmp.Height - top);
                o.WriteByte(0x1D); o.WriteByte(0x76); o.WriteByte(0x30); o.WriteByte(0x00);
                o.WriteByte((byte)(bytesPerRow & 0xFF)); o.WriteByte((byte)(bytesPerRow >> 8));
                o.WriteByte((byte)(rows & 0xFF)); o.WriteByte((byte)(rows >> 8));
                for (int yy = top; yy < top + rows; yy++)
                {
                    for (int bx = 0; bx < bytesPerRow; bx++)
                    {
                        int b = 0;
                        for (int bit = 0; bit < 8; bit++)
                        {
                            var c = bmp.GetPixel(bx * 8 + bit, yy);
                            if (c.R + c.G + c.B < 384) b |= 0x80 >> bit;
                        }
                        o.WriteByte((byte)b);
                    }
                }
            }
            if (s.Cut)
            {
                // GS V 1: partial cut where the paper is now, without feeding to the cutter,
                // so every label advances exactly label + gap and the cut stays in phase.
                o.WriteByte(0x1D); o.WriteByte(0x56); o.WriteByte(0x01);
            }
            return o.ToArray();
        }

        /// <summary>Feeds paper without printing (ESC J), to bring the cut into the gap.</summary>
        public static void Feed(Settings s, int mm)
        {
            var o = new MemoryStream();
            o.WriteByte(0x1B); o.WriteByte(0x40);
            int dots = Math.Max(0, Math.Min(200, mm)) * LabelRenderer.DotsPerMm;
            while (dots > 0)
            {
                int n = Math.Min(255, dots);
                o.WriteByte(0x1B); o.WriteByte(0x4A); o.WriteByte((byte)n);
                dots -= n;
            }
            SendRaw(s.PrinterName, o.ToArray(), "Маркировка: подача");
        }

        public static void Print(Product p, DateTime made, DateTime until, string employee, int copies, Settings s)
        {
            if (string.IsNullOrWhiteSpace(s.PrinterName))
                throw new InvalidOperationException("Принтер не выбран. Откройте «Настройки».");
            using (var bmp = LabelRenderer.Render(p, made, until, employee, s))
            {
                if (s.Mode == "driver")
                {
                    PrintViaDriver(bmp, copies, s);
                    return;
                }
                byte[] one;
                using (var page = LabelRenderer.Compose(bmp, s)) one = EscPos(page, s);
                var all = new MemoryStream();
                for (int i = 0; i < copies; i++) all.Write(one, 0, one.Length);
                SendRaw(s.PrinterName, all.ToArray(), "Маркировка: " + p.Name);
            }
        }

        static void PrintViaDriver(Bitmap bmp, int copies, Settings s)
        {
            int left = copies;
            using (var doc = new PrintDocument())
            {
                doc.DocumentName = "Маркировка";
                doc.PrinterSettings.PrinterName = s.PrinterName;
                if (!doc.PrinterSettings.IsValid)
                    throw new InvalidOperationException("Принтер «" + s.PrinterName + "» не найден.");
                doc.PrintController = new StandardPrintController();
                // Hundredths of an inch.
                int wIn = (int)Math.Round(s.PrintWidthMm / 25.4 * 100) + 8;
                int hIn = (int)Math.Round((s.LabelHeightMm + s.GapMm) / 25.4 * 100);
                doc.DefaultPageSettings.PaperSize = new PaperSize("Этикетка", wIn, hIn);
                doc.DefaultPageSettings.Margins = new Margins(0, 0, 0, 0);
                doc.PrintPage += (sender, e) =>
                {
                    e.Graphics.PageUnit = GraphicsUnit.Millimeter;
                    e.Graphics.InterpolationMode = InterpolationMode.NearestNeighbor;
                    e.Graphics.DrawImage(bmp, (float)s.OffsetXMm, (float)s.OffsetYMm, (float)s.PrintWidthMm, (float)s.LabelHeightMm);
                    left--;
                    e.HasMorePages = left > 0;
                };
                doc.Print();
            }
        }
    }

    // ------------------------------------------------------------------ UI helpers

    static class Ui
    {
        public static readonly Color Bg = Color.FromArgb(245, 243, 239);
        public static readonly Color Panel = Color.White;
        public static readonly Color Accent = Color.FromArgb(230, 81, 0);
        public static readonly Color AccentDark = Color.FromArgb(190, 60, 0);
        public static readonly Color Text = Color.FromArgb(33, 33, 33);
        public static readonly Color Muted = Color.FromArgb(110, 110, 110);
        public static readonly Color Line = Color.FromArgb(222, 218, 210);
        public static readonly Color Green = Color.FromArgb(46, 125, 50);

        public static Font F(float size, bool bold)
        {
            return new Font("Segoe UI", size, bold ? FontStyle.Bold : FontStyle.Regular, GraphicsUnit.Point);
        }

        public static Button Btn(string text, Color back, Color fore, float size)
        {
            var b = new Button();
            b.Text = text;
            b.FlatStyle = FlatStyle.Flat;
            b.FlatAppearance.BorderSize = 0;
            b.BackColor = back;
            b.ForeColor = fore;
            b.Font = F(size, true);
            b.Cursor = Cursors.Hand;
            b.UseVisualStyleBackColor = false;
            return b;
        }

        public static Label Lbl(string text, float size, bool bold, Color color)
        {
            var l = new Label();
            l.Text = text;
            l.Font = F(size, bold);
            l.ForeColor = color;
            l.AutoSize = true;
            l.BackColor = Color.Transparent;
            return l;
        }
    }

    // ------------------------------------------------------------------ main window

    public class MainForm : Form
    {
        List<Product> products;
        Settings settings;
        Product selected;
        string category = null; // null = all
        bool manualTime = false;
        bool settingTime = false;
        int copies = 1;
        FlowLayoutPanel topButtons;

        FlowLayoutPanel categoryBar, tiles;
        Label clock, selName, selShelf, selStorage, untilLabel, madeHint, copiesLabel, status;
        DateTimePicker madePicker;
        ComboBox employee;
        Button printBtn, nowBtn;
        PictureBox preview;
        Timer timer;

        public MainForm()
        {
            Text = "PickChick — Маркировка продуктов";
            BackColor = Ui.Bg;
            Font = Ui.F(11f, false);
            WindowState = FormWindowState.Maximized;
            MinimumSize = new Size(1000, 640);
            StartPosition = FormStartPosition.CenterScreen;
            try { Icon = Icon.ExtractAssociatedIcon(Application.ExecutablePath); } catch { }

            products = Store.LoadProducts();
            settings = Store.LoadSettings();
            BuildUi();
            RenderCategories();
            RenderTiles();
            UpdateSelection();

            timer = new Timer();
            timer.Interval = 1000;
            timer.Tick += delegate { Tick(); };
            timer.Start();
            Tick();
        }

        void BuildUi()
        {
            // Top bar
            var top = new Panel();
            top.Dock = DockStyle.Top;
            top.Height = 64;
            top.BackColor = Ui.Accent;
            var title = Ui.Lbl("Маркировка продуктов", 18f, true, Color.White);
            title.Location = new Point(18, 14);
            top.Controls.Add(title);

            clock = Ui.Lbl("", 16f, true, Color.White);
            clock.Anchor = AnchorStyles.Top | AnchorStyles.Right;
            top.Controls.Add(clock);

            topButtons = new FlowLayoutPanel();
            topButtons.FlowDirection = FlowDirection.RightToLeft;
            topButtons.Anchor = AnchorStyles.Top | AnchorStyles.Right;
            topButtons.BackColor = Color.Transparent;
            topButtons.WrapContents = false;
            topButtons.Size = new Size(470, 56);
            foreach (var spec in new[] { "Настройки", "Журнал", "Продукты" })
            {
                var b = Ui.Btn(spec, Ui.AccentDark, Color.White, 12f);
                b.Size = new Size(145, 46);
                b.Margin = new Padding(4, 5, 4, 0);
                string name = spec;
                b.Click += delegate { TopAction(name); };
                topButtons.Controls.Add(b);
            }
            top.Controls.Add(topButtons);
            top.Resize += delegate
            {
                topButtons.Location = new Point(top.Width - topButtons.Width - 10, 4);
                clock.Location = new Point(topButtons.Left - clock.Width - 24, 18);
            };

            // Right panel: selected product and printing
            var right = new Panel();
            right.Dock = DockStyle.Right;
            right.Width = 460;
            right.BackColor = Ui.Panel;
            right.Padding = new Padding(20, 14, 20, 14);

            var stack = new TableLayoutPanel();
            stack.Dock = DockStyle.Fill;
            stack.ColumnCount = 1;
            stack.AutoScroll = true;
            stack.BackColor = Ui.Panel;
            stack.GrowStyle = TableLayoutPanelGrowStyle.AddRows;

            selName = Ui.Lbl("Выберите продукт слева", 17f, true, Ui.Text);
            selName.AutoSize = false;
            selName.Size = new Size(410, 60);
            selShelf = Ui.Lbl("", 12f, false, Ui.Muted);
            selStorage = Ui.Lbl("", 12f, false, Ui.Muted);

            var madeRow = new FlowLayoutPanel();
            madeRow.AutoSize = true;
            madeRow.WrapContents = false;
            madeRow.Margin = new Padding(0, 10, 0, 0);
            var madeCaption = Ui.Lbl("Изготовлено / вскрыто", 11f, true, Ui.Text);
            madePicker = new DateTimePicker();
            madePicker.Format = DateTimePickerFormat.Custom;
            madePicker.CustomFormat = "dd.MM.yyyy   HH:mm";
            madePicker.Font = Ui.F(16f, true);
            madePicker.Width = 270;
            madePicker.ValueChanged += delegate
            {
                if (!settingTime) { manualTime = true; nowBtn.Visible = true; }
                UpdateSelection();
            };
            nowBtn = Ui.Btn("Сейчас", Ui.Line, Ui.Text, 11f);
            nowBtn.Size = new Size(110, 40);
            nowBtn.Margin = new Padding(10, 0, 0, 0);
            nowBtn.Visible = false;
            nowBtn.Click += delegate { manualTime = false; nowBtn.Visible = false; Tick(); };
            madeRow.Controls.Add(madePicker);
            madeRow.Controls.Add(nowBtn);
            madeHint = Ui.Lbl("Время берётся текущее. Измените, если продукт сделан раньше.", 9.5f, false, Ui.Muted);

            var untilCaption = Ui.Lbl("Годен до", 11f, true, Ui.Text);
            untilCaption.Margin = new Padding(3, 12, 3, 0);
            untilLabel = Ui.Lbl("—", 24f, true, Ui.Accent);

            var empCaption = Ui.Lbl("Кто маркирует (необязательно)", 11f, true, Ui.Text);
            empCaption.Margin = new Padding(3, 12, 3, 0);
            employee = new ComboBox();
            employee.Font = Ui.F(14f, false);
            employee.Width = 410;
            employee.DropDownStyle = ComboBoxStyle.DropDown;
            foreach (var e in settings.Employees) employee.Items.Add(e);
            employee.Text = settings.LastEmployee;
            employee.TextChanged += delegate { UpdatePreview(); };

            var copiesRow = new FlowLayoutPanel();
            copiesRow.AutoSize = true;
            copiesRow.WrapContents = false;
            copiesRow.Margin = new Padding(0, 12, 0, 0);
            var copiesCaption = Ui.Lbl("Количество наклеек", 11f, true, Ui.Text);
            copiesCaption.Margin = new Padding(3, 16, 16, 0);
            var minus = Ui.Btn("−", Ui.Line, Ui.Text, 20f);
            minus.Size = new Size(64, 54);
            copiesLabel = Ui.Lbl("1", 20f, true, Ui.Text);
            copiesLabel.AutoSize = false;
            copiesLabel.TextAlign = ContentAlignment.MiddleCenter;
            copiesLabel.Size = new Size(70, 54);
            var plus = Ui.Btn("+", Ui.Line, Ui.Text, 20f);
            plus.Size = new Size(64, 54);
            minus.Click += delegate { SetCopies(copies - 1); };
            plus.Click += delegate { SetCopies(copies + 1); };
            copiesRow.Controls.Add(copiesCaption);
            copiesRow.Controls.Add(minus);
            copiesRow.Controls.Add(copiesLabel);
            copiesRow.Controls.Add(plus);

            printBtn = Ui.Btn("ПЕЧАТАТЬ", Ui.Green, Color.White, 20f);
            printBtn.Size = new Size(410, 76);
            printBtn.Margin = new Padding(3, 14, 3, 6);
            printBtn.Click += delegate { DoPrint(); };

            status = Ui.Lbl("", 10.5f, false, Ui.Muted);
            status.AutoSize = false;
            status.Size = new Size(410, 44);

            preview = new PictureBox();
            preview.Size = new Size(410, 230);
            preview.SizeMode = PictureBoxSizeMode.Zoom;
            preview.BackColor = Ui.Bg;
            preview.Margin = new Padding(3, 4, 3, 3);

            stack.Controls.Add(selName);
            stack.Controls.Add(selShelf);
            stack.Controls.Add(selStorage);
            stack.Controls.Add(madeCaption);
            madeCaption.Margin = new Padding(3, 14, 3, 0);
            stack.Controls.Add(madeRow);
            stack.Controls.Add(madeHint);
            stack.Controls.Add(untilCaption);
            stack.Controls.Add(untilLabel);
            stack.Controls.Add(empCaption);
            stack.Controls.Add(employee);
            stack.Controls.Add(copiesRow);
            stack.Controls.Add(printBtn);
            stack.Controls.Add(status);
            stack.Controls.Add(Ui.Lbl("Так будет выглядеть наклейка", 10f, true, Ui.Muted));
            stack.Controls.Add(preview);
            right.Controls.Add(stack);

            // Left: categories + product tiles
            var left = new Panel();
            left.Dock = DockStyle.Fill;
            left.Padding = new Padding(16, 10, 10, 10);

            categoryBar = new FlowLayoutPanel();
            categoryBar.Dock = DockStyle.Top;
            categoryBar.Height = 62;
            categoryBar.WrapContents = false;
            categoryBar.AutoScroll = true;

            tiles = new FlowLayoutPanel();
            tiles.Dock = DockStyle.Fill;
            tiles.AutoScroll = true;
            tiles.Padding = new Padding(0, 6, 0, 0);

            left.Controls.Add(tiles);
            left.Controls.Add(categoryBar);

            Controls.Add(left);
            Controls.Add(right);
            Controls.Add(top);
        }

        void TopAction(string name)
        {
            if (name == "Продукты")
            {
                using (var f = new ProductsForm(products))
                {
                    if (f.ShowDialog(this) == DialogResult.OK)
                    {
                        products = f.Result;
                        Store.SaveProducts(products);
                        if (selected != null && !products.Contains(selected)) selected = null;
                        if (category != null && !products.Any(p => p.Category == category)) category = null;
                        RenderCategories();
                        RenderTiles();
                        UpdateSelection();
                    }
                }
            }
            else if (name == "Журнал")
            {
                using (var f = new JournalForm()) f.ShowDialog(this);
            }
            else
            {
                using (var f = new SettingsForm(settings))
                {
                    if (f.ShowDialog(this) == DialogResult.OK)
                    {
                        Store.SaveSettings(settings);
                        UpdatePreview();
                    }
                }
            }
        }

        List<string> Categories()
        {
            var list = new List<string>();
            foreach (var p in products)
                if (!list.Contains(p.Category)) list.Add(p.Category);
            return list;
        }

        void RenderCategories()
        {
            categoryBar.SuspendLayout();
            categoryBar.Controls.Clear();
            var all = new List<string> { null };
            all.AddRange(Categories());
            foreach (var c in all)
            {
                string cat = c;
                bool active = cat == category;
                var b = Ui.Btn(cat ?? "Все", active ? Ui.Accent : Color.White, active ? Color.White : Ui.Text, 12f);
                b.AutoSize = true;
                b.MinimumSize = new Size(90, 48);
                b.Padding = new Padding(10, 0, 10, 0);
                b.Margin = new Padding(0, 4, 8, 4);
                b.Click += delegate { category = cat; RenderCategories(); RenderTiles(); };
                categoryBar.Controls.Add(b);
            }
            categoryBar.ResumeLayout();
        }

        void RenderTiles()
        {
            tiles.SuspendLayout();
            tiles.Controls.Clear();
            foreach (var p in products)
            {
                if (category != null && p.Category != category) continue;
                Product prod = p;
                bool active = prod == selected;
                var b = new Button();
                b.FlatStyle = FlatStyle.Flat;
                b.FlatAppearance.BorderColor = active ? Ui.Accent : Ui.Line;
                b.FlatAppearance.BorderSize = active ? 3 : 1;
                b.BackColor = active ? Color.FromArgb(255, 236, 222) : Color.White;
                b.ForeColor = Ui.Text;
                b.Size = new Size(212, 104);
                b.Margin = new Padding(0, 0, 10, 10);
                b.Font = Ui.F(12f, true);
                b.TextAlign = ContentAlignment.MiddleLeft;
                b.Padding = new Padding(8, 0, 4, 0);
                b.Text = prod.Name + "\n" + "Срок: " + prod.ShelfText();
                b.Cursor = Cursors.Hand;
                b.Click += delegate { selected = prod; SetCopies(1); RenderTiles(); UpdateSelection(); };
                tiles.Controls.Add(b);
            }
            tiles.ResumeLayout();
        }

        void SetCopies(int n)
        {
            copies = Math.Max(1, Math.Min(50, n));
            copiesLabel.Text = copies.ToString();
        }

        void Tick()
        {
            var now = DateTime.Now;
            clock.Text = now.ToString("dd.MM.yyyy  HH:mm");
            clock.Location = new Point(topButtons.Left - clock.Width - 24, 18);
            if (!manualTime)
            {
                var minute = new DateTime(now.Year, now.Month, now.Day, now.Hour, now.Minute, 0);
                if (madePicker.Value != minute)
                {
                    settingTime = true;
                    madePicker.Value = minute;
                    settingTime = false;
                }
            }
        }

        void UpdateSelection()
        {
            bool has = selected != null;
            printBtn.Enabled = has;
            printBtn.BackColor = has ? Ui.Green : Ui.Line;
            if (!has)
            {
                selName.Text = "Выберите продукт слева";
                selShelf.Text = "";
                selStorage.Text = "";
                untilLabel.Text = "—";
                preview.Image = null;
                return;
            }
            selName.Text = selected.Name;
            selShelf.Text = "Срок годности: " + selected.ShelfText();
            selStorage.Text = string.IsNullOrWhiteSpace(selected.Storage) ? "" : "Хранить: " + selected.Storage;
            var until = selected.ExpiryFrom(madePicker.Value);
            untilLabel.Text = until.ToString("dd.MM.yyyy   HH:mm");
            UpdatePreview();
        }

        void UpdatePreview()
        {
            if (selected == null) return;
            var made = madePicker.Value;
            var old = preview.Image;
            preview.Image = LabelRenderer.Render(selected, made, selected.ExpiryFrom(made), employee.Text, settings);
            if (old != null) old.Dispose();
        }

        void DoPrint()
        {
            if (selected == null) return;
            var made = madePicker.Value;
            var until = selected.ExpiryFrom(made);
            string emp = (employee.Text ?? "").Trim();
            printBtn.Enabled = false;
            Cursor = Cursors.WaitCursor;
            try
            {
                Printer.Print(selected, made, until, emp, copies, settings);
                try
                {
                    var e = new JournalEntry();
                    e.Printed = DateTime.Now; e.Product = selected.Name; e.Made = made; e.Until = until;
                    e.Copies = copies; e.Employee = emp;
                    Store.AppendJournal(e);
                }
                catch { }
                if (emp.Length > 0 && !settings.Employees.Contains(emp))
                {
                    settings.Employees.Add(emp);
                    employee.Items.Add(emp);
                }
                settings.LastEmployee = emp;
                try { Store.SaveSettings(settings); } catch { }
                status.ForeColor = Ui.Green;
                status.Text = "Напечатано: " + selected.Name + " × " + copies + "  (" + DateTime.Now.ToString("HH:mm") + ")";
                SetCopies(1);
            }
            catch (Exception ex)
            {
                status.ForeColor = Color.Firebrick;
                status.Text = "Не напечатано: " + ex.Message;
            }
            finally
            {
                Cursor = Cursors.Default;
                printBtn.Enabled = true;
            }
        }
    }

    // ------------------------------------------------------------------ products editor

    public class ProductsForm : Form
    {
        DataGridView grid;
        public List<Product> Result;
        static readonly string[] UnitNames = { "мин", "ч", "сут" };
        static readonly string[] UnitCodes = { "min", "h", "d" };

        public ProductsForm(List<Product> products)
        {
            Text = "Продукты и сроки годности";
            Size = new Size(1100, 700);
            StartPosition = FormStartPosition.CenterParent;
            BackColor = Ui.Bg;
            Font = Ui.F(11f, false);

            grid = new DataGridView();
            grid.Dock = DockStyle.Fill;
            grid.BackgroundColor = Color.White;
            grid.RowTemplate.Height = 40;
            grid.ColumnHeadersHeight = 44;
            grid.ColumnHeadersHeightSizeMode = DataGridViewColumnHeadersHeightSizeMode.DisableResizing;
            grid.AllowUserToAddRows = true;
            grid.AllowUserToDeleteRows = true;
            grid.SelectionMode = DataGridViewSelectionMode.CellSelect;
            grid.EditMode = DataGridViewEditMode.EditOnEnter;
            grid.DefaultCellStyle.Font = Ui.F(12f, false);
            grid.ColumnHeadersDefaultCellStyle.Font = Ui.F(11f, true);

            var cCat = new DataGridViewTextBoxColumn();
            cCat.HeaderText = "Группа"; cCat.Width = 190;
            var cName = new DataGridViewTextBoxColumn();
            cName.HeaderText = "Название"; cName.AutoSizeMode = DataGridViewAutoSizeColumnMode.Fill;
            var cShelf = new DataGridViewTextBoxColumn();
            cShelf.HeaderText = "Срок"; cShelf.Width = 90;
            var cUnit = new DataGridViewComboBoxColumn();
            cUnit.HeaderText = "Ед."; cUnit.Width = 90;
            cUnit.Items.AddRange(UnitNames);
            cUnit.FlatStyle = FlatStyle.Flat;
            var cStorage = new DataGridViewTextBoxColumn();
            cStorage.HeaderText = "Условия хранения"; cStorage.Width = 200;
            grid.Columns.AddRange(new DataGridViewColumn[] { cCat, cName, cShelf, cUnit, cStorage });

            foreach (var p in products)
                grid.Rows.Add(p.Category, p.Name, p.Shelf.ToString(), UnitNames[Array.IndexOf(UnitCodes, p.Unit) < 0 ? 1 : Array.IndexOf(UnitCodes, p.Unit)], p.Storage);
            grid.DefaultValuesNeeded += (s, e) => { e.Row.Cells[3].Value = "ч"; e.Row.Cells[2].Value = "24"; };

            var bottom = new FlowLayoutPanel();
            bottom.Dock = DockStyle.Bottom;
            bottom.Height = 70;
            bottom.FlowDirection = FlowDirection.RightToLeft;
            bottom.Padding = new Padding(10);
            var save = Ui.Btn("Сохранить", Ui.Green, Color.White, 13f);
            save.Size = new Size(170, 48);
            save.Click += delegate { Save(); };
            var cancel = Ui.Btn("Отмена", Ui.Line, Ui.Text, 13f);
            cancel.Size = new Size(140, 48);
            cancel.Click += delegate { DialogResult = DialogResult.Cancel; Close(); };
            var del = Ui.Btn("Удалить строку", Ui.Line, Color.Firebrick, 13f);
            del.Size = new Size(190, 48);
            del.Click += delegate
            {
                var cell = grid.CurrentCell;
                if (cell != null && !grid.Rows[cell.RowIndex].IsNewRow) grid.Rows.RemoveAt(cell.RowIndex);
            };
            var hint = Ui.Lbl("Новый продукт — впишите в последнюю пустую строку.", 10.5f, false, Ui.Muted);
            hint.Margin = new Padding(10, 16, 10, 0);
            bottom.Controls.Add(save);
            bottom.Controls.Add(cancel);
            bottom.Controls.Add(del);
            bottom.Controls.Add(hint);

            Controls.Add(grid);
            Controls.Add(bottom);
        }

        void Save()
        {
            grid.EndEdit();
            var list = new List<Product>();
            for (int i = 0; i < grid.Rows.Count; i++)
            {
                var r = grid.Rows[i];
                if (r.IsNewRow) continue;
                string name = Convert.ToString(r.Cells[1].Value ?? "").Trim();
                string cat = Convert.ToString(r.Cells[0].Value ?? "").Trim();
                string shelfText = Convert.ToString(r.Cells[2].Value ?? "").Trim();
                string unitName = Convert.ToString(r.Cells[3].Value ?? "ч");
                string storage = Convert.ToString(r.Cells[4].Value ?? "").Trim();
                if (name.Length == 0 && cat.Length == 0 && shelfText.Length == 0) continue;
                int shelf;
                if (name.Length == 0)
                {
                    Fail(i, 1, "Строка " + (i + 1) + ": впишите название.");
                    return;
                }
                if (!int.TryParse(shelfText, NumberStyles.Integer, CultureInfo.InvariantCulture, out shelf) || shelf <= 0 || shelf > 100000)
                {
                    Fail(i, 2, "«" + name + "»: срок должен быть целым числом больше нуля.");
                    return;
                }
                int u = Array.IndexOf(UnitNames, unitName);
                list.Add(new Product(cat.Length == 0 ? "Прочее" : cat, name, shelf, UnitCodes[u < 0 ? 1 : u], storage));
            }
            if (list.Count == 0)
            {
                MessageBox.Show(this, "Список пуст. Добавьте хотя бы один продукт.", "Продукты");
                return;
            }
            Result = list;
            DialogResult = DialogResult.OK;
            Close();
        }

        void Fail(int row, int col, string msg)
        {
            grid.CurrentCell = grid.Rows[row].Cells[col];
            MessageBox.Show(this, msg, "Продукты", MessageBoxButtons.OK, MessageBoxIcon.Warning);
        }
    }

    // ------------------------------------------------------------------ journal

    public class JournalForm : Form
    {
        public JournalForm()
        {
            Text = "Журнал маркировки (последние 500)";
            Size = new Size(1100, 700);
            StartPosition = FormStartPosition.CenterParent;
            Font = Ui.F(11f, false);

            var list = new ListView();
            list.Dock = DockStyle.Fill;
            list.View = View.Details;
            list.FullRowSelect = true;
            list.GridLines = true;
            list.Font = Ui.F(12f, false);
            list.Columns.Add("Напечатано", 170);
            list.Columns.Add("Продукт", 360);
            list.Columns.Add("Маркировано", 170);
            list.Columns.Add("Годен до", 170);
            list.Columns.Add("Шт.", 60);
            list.Columns.Add("Сотрудник", 150);
            try
            {
                foreach (var row in Store.ReadJournal(500)) list.Items.Add(new ListViewItem(row.Take(6).ToArray()));
            }
            catch (Exception ex)
            {
                list.Items.Add(new ListViewItem(new[] { "Ошибка чтения журнала", ex.Message }));
            }

            var bottom = new FlowLayoutPanel();
            bottom.Dock = DockStyle.Bottom;
            bottom.Height = 66;
            bottom.Padding = new Padding(10);
            bottom.FlowDirection = FlowDirection.RightToLeft;
            var close = Ui.Btn("Закрыть", Ui.Line, Ui.Text, 13f);
            close.Size = new Size(150, 46);
            close.Click += delegate { Close(); };
            var file = Ui.Lbl("Файл для Excel: " + Store.JournalFile, 10f, false, Ui.Muted);
            file.Margin = new Padding(10, 14, 10, 0);
            bottom.Controls.Add(close);
            bottom.Controls.Add(file);

            Controls.Add(list);
            Controls.Add(bottom);
        }
    }

    // ------------------------------------------------------------------ settings

    public class SettingsForm : Form
    {
        readonly Settings s;
        ComboBox printer, mode;
        NumericUpDown width, height, gap, offY, offX;
        CheckBox cut;

        public SettingsForm(Settings settings)
        {
            s = settings;
            Text = "Настройки печати";
            Size = new Size(680, 720);
            StartPosition = FormStartPosition.CenterParent;
            FormBorderStyle = FormBorderStyle.FixedDialog;
            MaximizeBox = false; MinimizeBox = false;
            BackColor = Ui.Bg;
            Font = Ui.F(12f, false);

            var t = new TableLayoutPanel();
            t.Dock = DockStyle.Fill;
            t.ColumnCount = 2;
            t.Padding = new Padding(18);
            t.ColumnStyles.Add(new ColumnStyle(SizeType.Absolute, 250));
            t.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 100));

            printer = new ComboBox();
            printer.DropDownStyle = ComboBoxStyle.DropDownList;
            printer.Width = 320;
            foreach (string p in PrinterSettings.InstalledPrinters) printer.Items.Add(p);
            if (printer.Items.Contains(s.PrinterName)) printer.SelectedItem = s.PrinterName;
            else if (printer.Items.Count > 0) printer.SelectedIndex = 0;

            mode = new ComboBox();
            mode.DropDownStyle = ComboBoxStyle.DropDownList;
            mode.Width = 320;
            mode.Items.Add("Чековый принтер (ESC/POS)");
            mode.Items.Add("Через драйвер Windows");
            mode.SelectedIndex = s.Mode == "driver" ? 1 : 0;

            width = Num(20, 72, s.PrintWidthMm);
            height = Num(15, 200, s.LabelHeightMm);
            gap = Num(0, 30, s.GapMm);
            offY = Num(0, 60, s.OffsetYMm);
            offX = Num(0, 52, s.OffsetXMm);
            cut = new CheckBox();
            cut.Text = "Отрезать между наклейками";
            cut.Checked = s.Cut;
            cut.AutoSize = true;

            Row(t, "Принтер", printer);
            Row(t, "Способ печати", mode);
            Row(t, "Ширина наклейки, мм", width);
            Row(t, "Длина наклейки, мм", height);
            Row(t, "Промежуток, мм", gap);
            Row(t, "Сдвиг печати вниз, мм", offY);
            Row(t, "Сдвиг печати вправо, мм", offX);
            Row(t, "", cut);
            var feedRow = new FlowLayoutPanel();
            feedRow.AutoSize = true;
            feedRow.WrapContents = false;
            foreach (var mm in new[] { 1, 5, 10 })
            {
                int step = mm;
                var b = Ui.Btn("+" + mm + " мм", Ui.Line, Ui.Text, 11f);
                b.Size = new Size(90, 40);
                b.Margin = new Padding(0, 0, 8, 0);
                b.Click += delegate { FeedPaper(step); };
                feedRow.Controls.Add(b);
            }
            Row(t, "Подать бумагу", feedRow);
            var note = Ui.Lbl("Если отрезка попадает на наклейку — подайте бумагу\nкнопками «+1 мм», пока отрезка не встанет в промежуток.\nЕсли текст сползает с наклейки — меняйте сдвиг.", 10f, false, Ui.Muted);
            t.Controls.Add(new Label(), 0, t.RowCount);
            t.Controls.Add(note, 1, t.RowCount);
            t.RowCount++;

            var bottom = new FlowLayoutPanel();
            bottom.Dock = DockStyle.Bottom;
            bottom.Height = 70;
            bottom.Padding = new Padding(10);
            bottom.FlowDirection = FlowDirection.RightToLeft;
            var save = Ui.Btn("Сохранить", Ui.Green, Color.White, 13f);
            save.Size = new Size(160, 48);
            save.Click += delegate { Apply(s); DialogResult = DialogResult.OK; Close(); };
            var cancel = Ui.Btn("Отмена", Ui.Line, Ui.Text, 13f);
            cancel.Size = new Size(130, 48);
            cancel.Click += delegate { DialogResult = DialogResult.Cancel; Close(); };
            var test = Ui.Btn("Пробная наклейка", Ui.Accent, Color.White, 13f);
            test.Size = new Size(210, 48);
            test.Click += delegate { TestPrint(); };
            bottom.Controls.Add(save);
            bottom.Controls.Add(cancel);
            bottom.Controls.Add(test);

            Controls.Add(t);
            Controls.Add(bottom);
        }

        static NumericUpDown Num(int min, int max, int value)
        {
            var n = new NumericUpDown();
            n.Minimum = min; n.Maximum = max;
            n.Value = Math.Max(min, Math.Min(max, value));
            n.Width = 110;
            n.Font = Ui.F(13f, false);
            return n;
        }

        static void Row(TableLayoutPanel t, string caption, Control c)
        {
            var l = Ui.Lbl(caption, 12f, true, Ui.Text);
            l.Margin = new Padding(3, 10, 3, 3);
            c.Margin = new Padding(3, 6, 3, 6);
            t.Controls.Add(l, 0, t.RowCount);
            t.Controls.Add(c, 1, t.RowCount);
            t.RowCount++;
        }

        void Apply(Settings target)
        {
            target.PrinterName = printer.SelectedItem == null ? "" : printer.SelectedItem.ToString();
            target.Mode = mode.SelectedIndex == 1 ? "driver" : "escpos";
            target.PrintWidthMm = (int)width.Value;
            target.LabelHeightMm = (int)height.Value;
            target.GapMm = (int)gap.Value;
            target.OffsetYMm = (int)offY.Value;
            target.OffsetXMm = (int)offX.Value;
            target.Cut = cut.Checked;
            Store.Normalize(target);
        }

        void FeedPaper(int mm)
        {
            var tmp = new Settings();
            Apply(tmp);
            try { Printer.Feed(tmp, mm); }
            catch (Exception ex)
            {
                MessageBox.Show(this, ex.Message, "Подача бумаги", MessageBoxButtons.OK, MessageBoxIcon.Warning);
            }
        }

        void TestPrint()
        {
            var tmp = new Settings();
            Apply(tmp);
            var p = new Product("Прочее", "Пробная наклейка", 24, "h", "+2…+6 °C");
            var now = DateTime.Now;
            try
            {
                Printer.Print(p, now, p.ExpiryFrom(now), "", 1, tmp);
                MessageBox.Show(this, "Отправлено на принтер.", "Пробная наклейка");
            }
            catch (Exception ex)
            {
                MessageBox.Show(this, ex.Message, "Пробная наклейка", MessageBoxButtons.OK, MessageBoxIcon.Warning);
            }
        }
    }

    // ------------------------------------------------------------------ entry point

    static class Program
    {
        [STAThread]
        static int Main(string[] args)
        {
            // Command line for setup checks without the window:
            //   --render <out.png> [product]   draw a label to a PNG
            //   --print [product]              print one label with the saved settings
            //   --printers                     list Windows printers
            //   --set key=value ...            change settings (width height gap offy offx cut mode printer)
            //   --feed <mm>                    feed paper without printing
            if (args.Length > 0) return Cli(args);

            bool created;
            using (var mutex = new System.Threading.Mutex(true, "PickChick.Labels.SingleInstance", out created))
            {
                if (!created)
                {
                    MessageBox.Show("Программа маркировки уже открыта.", "Маркировка");
                    return 0;
                }
                Application.EnableVisualStyles();
                Application.SetCompatibleTextRenderingDefault(false);
                Application.ThreadException += (s, e) =>
                    MessageBox.Show("Ошибка: " + e.Exception.Message, "Маркировка", MessageBoxButtons.OK, MessageBoxIcon.Error);
                Application.Run(new MainForm());
            }
            return 0;
        }

        static int Cli(string[] args)
        {
            try
            {
                var products = Store.LoadProducts();
                var settings = Store.LoadSettings();
                if (args[0] == "--printers")
                {
                    foreach (string p in PrinterSettings.InstalledPrinters) Console.WriteLine(p);
                    Console.WriteLine("selected: " + settings.PrinterName);
                    return 0;
                }
                if (args[0] == "--set")
                {
                    // --set width=40 height=40 gap=3 offy=0 offx=0 cut=1 mode=escpos
                    for (int i = 1; i < args.Length; i++)
                    {
                        var kv = args[i].Split(new[] { '=' }, 2);
                        if (kv.Length != 2) throw new ArgumentException("bad: " + args[i]);
                        string key = kv[0].ToLowerInvariant(), v = kv[1];
                        if (key == "width") settings.PrintWidthMm = int.Parse(v);
                        else if (key == "height") settings.LabelHeightMm = int.Parse(v);
                        else if (key == "gap") settings.GapMm = int.Parse(v);
                        else if (key == "offy") settings.OffsetYMm = int.Parse(v);
                        else if (key == "offx") settings.OffsetXMm = int.Parse(v);
                        else if (key == "cut") settings.Cut = v == "1" || v == "true";
                        else if (key == "mode") settings.Mode = v == "driver" ? "driver" : "escpos";
                        else if (key == "printer") settings.PrinterName = v;
                        else throw new ArgumentException("unknown key: " + key);
                    }
                    Store.Normalize(settings);
                    Store.SaveSettings(settings);
                    Console.WriteLine(new JavaScriptSerializer().Serialize(settings));
                    return 0;
                }
                if (args[0] == "--feed")
                {
                    Printer.Feed(settings, args.Length > 1 ? int.Parse(args[1]) : 1);
                    Console.WriteLine("fed");
                    return 0;
                }
                string want = null;
                string outPath = null;
                if (args[0] == "--render") { outPath = args.Length > 1 ? args[1] : "label.png"; want = args.Length > 2 ? args[2] : null; }
                else if (args[0] == "--print") { want = args.Length > 1 ? args[1] : null; }
                else { Console.Error.WriteLine("unknown option"); return 2; }

                Product prod = want == null ? products[0] :
                    products.FirstOrDefault(p => p.Name.IndexOf(want, StringComparison.OrdinalIgnoreCase) >= 0);
                if (prod == null) { Console.Error.WriteLine("product not found: " + want); return 3; }
                var now = DateTime.Now;
                now = new DateTime(now.Year, now.Month, now.Day, now.Hour, now.Minute, 0);
                if (outPath != null)
                {
                    using (var bmp = LabelRenderer.Render(prod, now, prod.ExpiryFrom(now), "", settings))
                    using (var page = LabelRenderer.Compose(bmp, settings))
                        page.Save(outPath, ImageFormat.Png);
                    Console.WriteLine("rendered " + prod.Name + " -> " + outPath);
                }
                else
                {
                    Printer.Print(prod, now, prod.ExpiryFrom(now), "", 1, settings);
                    Console.WriteLine("printed " + prod.Name + " on " + settings.PrinterName + " (" + settings.Mode + ")");
                }
                return 0;
            }
            catch (Exception ex)
            {
                Console.Error.WriteLine("error: " + ex.Message);
                return 1;
            }
        }
    }
}
