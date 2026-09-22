// 生成 1024x1024 应用图标:纯黑渐变底 + 绿色 F(与页面纯黑风格一致)
import AppKit

let size: CGFloat = 1024
let img = NSImage(size: NSSize(width: size, height: size))
img.lockFocus()

let rect = NSRect(x: 0, y: 0, width: size, height: size)
if let grad = NSGradient(colors: [
    NSColor(calibratedWhite: 0.00, alpha: 1),
    NSColor(calibratedRed: 0.02, green: 0.10, blue: 0.075, alpha: 1),
]) {
    grad.draw(in: rect, angle: -90)
}

let para = NSMutableParagraphStyle()
para.alignment = .center
let attrs: [NSAttributedString.Key: Any] = [
    .font: NSFont.systemFont(ofSize: 600, weight: .bold),
    .foregroundColor: NSColor(calibratedRed: 0.063, green: 0.725, blue: 0.506, alpha: 1),
    .paragraphStyle: para,
]
NSAttributedString(string: "F", attributes: attrs)
    .draw(in: NSRect(x: 0, y: 120, width: size, height: 760))

img.unlockFocus()

if let tiff = img.tiffRepresentation, let rep = NSBitmapImageRep(data: tiff),
   let png = rep.representation(using: .png, properties: [:]) {
    try png.write(to: URL(fileURLWithPath: "icon_1024.png"))
    print("icon_1024.png 已生成")
} else {
    print("生成失败")
    exit(1)
}
