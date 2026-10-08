// macOS 14+: swift crop-photos.swift ORIGINAL_PHOTOS_DIR EXTRA_PIKO_DIR REPO_ROOT
// Crop screenshot UI first, then use an alpha mask. RGB comes from the supplied photo;
// no image synthesis, label replacement, retouching or geometry changes.
import AppKit
import Vision
import CoreImage
import CryptoKit

struct Photo {
    let number: Int
    let extra: Bool
    let name: String
    let referenceOnly: Bool
    var crop: CGRect {
        number >= 9 || extra
            ? CGRect(x: 145, y: 350, width: 310, height: 585)
            : CGRect(x: 140, y: 155, width: 320, height: 795)
    }
}
guard CommandLine.arguments.count == 4 else {
    fatalError("Usage: swift crop-photos.swift ORIGINAL_PHOTOS_DIR EXTRA_PIKO_DIR REPO_ROOT")
}
let photos = [
    Photo(number: 1, extra: false, name: "fuse-peach", referenceOnly: false),
    Photo(number: 2, extra: false, name: "fuse-mango-pineapple", referenceOnly: true),
    Photo(number: 3, extra: false, name: "fuse-mango-chamomile", referenceOnly: false),
    Photo(number: 4, extra: false, name: "bonaqua-still", referenceOnly: false),
    Photo(number: 5, extra: false, name: "sprite", referenceOnly: false),
    Photo(number: 6, extra: false, name: "cola-classic", referenceOnly: false),
    Photo(number: 7, extra: false, name: "fanta", referenceOnly: false),
    Photo(number: 8, extra: false, name: "cola-zero", referenceOnly: false),
    Photo(number: 9, extra: false, name: "piko-apple", referenceOnly: false),
    Photo(number: 10, extra: false, name: "piko-orange", referenceOnly: false),
    Photo(number: 1, extra: true, name: "piko-multifruit", referenceOnly: true),
    Photo(number: 2, extra: true, name: "piko-peach", referenceOnly: true),
]
let root = URL(fileURLWithPath: CommandLine.arguments[3])
let context = CIContext()
func hash(_ data: Data) -> String { SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined() }
var records: [[String: Any]] = []
for photo in photos {
    let file = "\(photo.number)-Фото-\(photo.number).jpg"
    let source = URL(fileURLWithPath: CommandLine.arguments[photo.extra ? 2 : 1]).appendingPathComponent(file)
    let data = try Data(contentsOf: source)
    guard let image = NSImage(data: data) else { fatalError("Invalid source \(file)") }
    var rect = CGRect(origin: .zero, size: image.size)
    guard let original = image.cgImage(forProposedRect: &rect, context: nil, hints: nil),
          original.width == 590, original.height == 1280,
          let crop = original.cropping(to: photo.crop) else { fatalError("Unexpected screenshot size") }
    let handler = VNImageRequestHandler(cgImage: crop)
    let request = VNGenerateForegroundInstanceMaskRequest()
    try handler.perform([request])
    guard let observation = request.results?.first, !observation.allInstances.isEmpty else {
        fatalError("No product mask for \(photo.name)")
    }
    let mask = try observation.generateScaledMaskForImage(forInstances: observation.allInstances, from: handler)
    let input = CIImage(cgImage: crop)
    let result = input.applyingFilter("CIBlendWithMask", parameters: [
        kCIInputMaskImageKey: CIImage(cvPixelBuffer: mask),
        kCIInputBackgroundImageKey: CIImage(color: .clear).cropped(to: input.extent)
    ])
    let bitmap = NSBitmapImageRep(cgImage: context.createCGImage(result, from: input.extent)!)
    let png = bitmap.representation(using: .png, properties: [:])!
    let path = (photo.referenceOnly ? "docs/operations/images/kiosk-drink-photos/reference-only/" : "apps/kiosk/assets/drinks/") + photo.name + ".png"
    let target = root.appendingPathComponent(path)
    try FileManager.default.createDirectory(at: target.deletingLastPathComponent(), withIntermediateDirectories: true)
    try png.write(to: target)
    records.append([
        "name": photo.name, "source_set": photo.extra ? "extra-piko" : "original-drinks",
        "source_file": file, "source_sha256": hash(data), "output": path, "output_sha256": hash(png),
        "crop_xywh": [Int(photo.crop.minX), Int(photo.crop.minY), Int(photo.crop.width), Int(photo.crop.height)],
        "reference_only": photo.referenceOnly
    ])
    print("Saved \(photo.name)")
}
let manifest: [String: Any] = [
    "method": "Exact screenshot crop + Apple Vision foreground alpha mask; original RGB, no generation or resizing",
    "os": ProcessInfo.processInfo.operatingSystemVersionString,
    "mask_revision": VNGenerateForegroundInstanceMaskRequest().revision,
    "photos": records
]
let output = try JSONSerialization.data(withJSONObject: manifest, options: [.prettyPrinted, .sortedKeys, .withoutEscapingSlashes])
try (output + Data([10])).write(to: root.appendingPathComponent("apps/kiosk/assets/drinks/provenance.json"))
