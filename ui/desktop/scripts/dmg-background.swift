import AppKit

// Draw a Retina installation illustration with native fonts; no downloaded assets.
guard CommandLine.arguments.count == 2 else { exit(2) }
let size = NSSize(width: 640, height: 420)
let image = NSImage(size: size)
let bitmap = NSBitmapImageRep(bitmapDataPlanes: nil, pixelsWide: 1280, pixelsHigh: 840,
    bitsPerSample: 8, samplesPerPixel: 4, hasAlpha: true, isPlanar: false,
    colorSpaceName: .deviceRGB, bytesPerRow: 0, bitsPerPixel: 0)!
bitmap.size = size
image.addRepresentation(bitmap)
NSGraphicsContext.saveGraphicsState()
NSGraphicsContext.current = NSGraphicsContext(bitmapImageRep: bitmap)
NSColor(calibratedWhite: 0.975, alpha: 1).setFill()
NSRect(origin: .zero, size: size).fill()
func label(_ text: String, _ y: CGFloat, _ fontSize: CGFloat, _ bold: Bool = false) {
    let style = NSMutableParagraphStyle()
    style.alignment = .center
    (text as NSString).draw(in: NSRect(x: 24, y: y, width: 592, height: 36), withAttributes: [
        .font: bold ? NSFont.systemFont(ofSize: fontSize, weight: .semibold) : NSFont.systemFont(ofSize: fontSize),
        .foregroundColor: NSColor(calibratedWhite: bold ? 0.13 : 0.40, alpha: 1), .paragraphStyle: style])
}
label("CodeBuddy", 340, 27, true)
label("拖入应用程序文件夹以安装", 300, 16)
label("Drag to Applications to install", 272, 13)
let arrow = NSBezierPath()
arrow.lineWidth = 2.5
arrow.move(to: NSPoint(x: 294, y: 203))
arrow.line(to: NSPoint(x: 346, y: 203))
arrow.move(to: NSPoint(x: 336, y: 213))
arrow.line(to: NSPoint(x: 346, y: 203))
arrow.line(to: NSPoint(x: 336, y: 193))
NSColor(calibratedWhite: 0.55, alpha: 1).setStroke()
arrow.stroke()
label("安装后，从“应用程序”打开 CodeBuddy", 61, 13)
label("After installation, open CodeBuddy from Applications", 35, 12)
NSGraphicsContext.restoreGraphicsState()
try image.tiffRepresentation!.write(to: URL(fileURLWithPath: CommandLine.arguments[1]))
