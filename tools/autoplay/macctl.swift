import Foundation
import CoreGraphics
import Vision
import AppKit

func fail(_ msg: String) -> Never {
  FileHandle.standardError.write(Data((msg + "\n").utf8))
  exit(1)
}

func printJSON(_ obj: Any) {
  guard let data = try? JSONSerialization.data(withJSONObject: obj, options: [.prettyPrinted, .sortedKeys]) else {
    fail("cannot encode json")
  }
  FileHandle.standardOutput.write(data)
  FileHandle.standardOutput.write(Data("\n".utf8))
}

func windowInfo(_ w: [String: Any]) -> [String: Any]? {
  guard (w[kCGWindowLayer as String] as? Int ?? -1) == 0 else { return nil }
  guard let id = w[kCGWindowNumber as String] as? Int else { return nil }
  let owner = w[kCGWindowOwnerName as String] as? String ?? ""
  let title = w[kCGWindowName as String] as? String ?? ""
  let pid = w[kCGWindowOwnerPID as String] as? Int ?? 0
  var rect = CGRect.zero
  if let dict = w[kCGWindowBounds as String] as? NSDictionary,
     let r = CGRect(dictionaryRepresentation: dict) {
    rect = r
  }
  if rect.width < 120 || rect.height < 120 { return nil }
  return [
    "id": id,
    "owner": owner,
    "title": title,
    "pid": pid,
    "x": Double(rect.origin.x),
    "y": Double(rect.origin.y),
    "w": Double(rect.width),
    "h": Double(rect.height),
  ]
}

let args = CommandLine.arguments
guard args.count >= 2 else { fail("usage: macctl <windows|ocr> ...") }

switch args[1] {
case "windows":
  let opts: CGWindowListOption = [.optionOnScreenOnly, .excludeDesktopElements]
  guard let raw = CGWindowListCopyWindowInfo(opts, kCGNullWindowID) as? [[String: Any]] else {
    fail("cannot list windows")
  }
  var out: [[String: Any]] = []
  for w in raw {
    if let info = windowInfo(w) { out.append(info) }
  }
  printJSON(out)

case "hit":
  guard args.count >= 4, let x = Double(args[2]), let y = Double(args[3]) else {
    fail("usage: macctl hit <x> <y>")
  }
  let point = CGPoint(x: x, y: y)
  let raw = CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID) as? [[String: Any]] ?? []
  for w in raw {
    guard let info = windowInfo(w) else { continue }
    let rect = CGRect(x: info["x"] as! Double, y: info["y"] as! Double, width: info["w"] as! Double, height: info["h"] as! Double)
    if rect.contains(point) {
      printJSON(["hit": info])
      exit(0)
    }
  }
  printJSON(["hit": NSNull()])

case "click":
  guard args.count >= 4, let x = Double(args[2]), let y = Double(args[3]) else {
    fail("usage: macctl click <x> <y>")
  }
  let point = CGPoint(x: x, y: y)
  CGEvent(mouseEventSource: nil, mouseType: .mouseMoved, mouseCursorPosition: point, mouseButton: .left)?.post(tap: .cghidEventTap)
  usleep(30_000)
  CGEvent(mouseEventSource: nil, mouseType: .leftMouseDown, mouseCursorPosition: point, mouseButton: .left)?.post(tap: .cghidEventTap)
  usleep(60_000)
  CGEvent(mouseEventSource: nil, mouseType: .leftMouseUp, mouseCursorPosition: point, mouseButton: .left)?.post(tap: .cghidEventTap)
  printJSON(["clicked": true, "x": x, "y": y])

case "move":
  guard args.count >= 4, let x = Double(args[2]), let y = Double(args[3]) else {
    fail("usage: macctl move <x> <y>")
  }
  CGEvent(mouseEventSource: nil, mouseType: .mouseMoved, mouseCursorPosition: CGPoint(x: x, y: y), mouseButton: .left)?.post(tap: .cghidEventTap)
  printJSON(["moved": true, "x": x, "y": y])

case "cursor":
  let p = CGEvent(source: nil)?.location ?? .zero
  printJSON(["x": Double(p.x), "y": Double(p.y)])

case "clickp":
  guard args.count >= 5, let pid = Int32(args[2]), let x = Double(args[3]), let y = Double(args[4]) else {
    fail("usage: macctl clickp <pid> <x> <y>")
  }
  let point = CGPoint(x: x, y: y)
  let down = CGEvent(mouseEventSource: nil, mouseType: .leftMouseDown, mouseCursorPosition: point, mouseButton: .left)!
  down.setIntegerValueField(.mouseEventClickState, value: 1)
  down.postToPid(pid_t(pid))
  usleep(60_000)
  let up = CGEvent(mouseEventSource: nil, mouseType: .leftMouseUp, mouseCursorPosition: point, mouseButton: .left)!
  up.setIntegerValueField(.mouseEventClickState, value: 1)
  up.postToPid(pid_t(pid))
  printJSON(["clicked": true, "pid": Int(pid), "x": x, "y": y, "mode": "pid"])

case "dblclickp":
  guard args.count >= 5, let pid = Int32(args[2]), let x = Double(args[3]), let y = Double(args[4]) else {
    fail("usage: macctl dblclickp <pid> <x> <y>")
  }
  let point = CGPoint(x: x, y: y)
  func postToPid(_ type: CGEventType, _ clickState: Int64) {
    let e = CGEvent(mouseEventSource: nil, mouseType: type, mouseCursorPosition: point, mouseButton: .left)!
    e.setIntegerValueField(.mouseEventClickState, value: clickState)
    e.postToPid(pid_t(pid))
  }
  postToPid(.leftMouseDown, 1)
  usleep(50_000)
  postToPid(.leftMouseUp, 1)
  usleep(150_000)
  postToPid(.leftMouseDown, 2)
  usleep(50_000)
  postToPid(.leftMouseUp, 2)
  printJSON(["doubleClicked": true, "pid": Int(pid), "x": x, "y": y, "mode": "pid"])

case "dblclick":
  guard args.count >= 4, let x = Double(args[2]), let y = Double(args[3]) else {
    fail("usage: macctl dblclick <x> <y>")
  }
  let point = CGPoint(x: x, y: y)
  func post(_ type: CGEventType, _ clickState: Int64) {
    let e = CGEvent(mouseEventSource: nil, mouseType: type, mouseCursorPosition: point, mouseButton: .left)
    e?.setIntegerValueField(.mouseEventClickState, value: clickState)
    e?.post(tap: .cghidEventTap)
  }
  CGEvent(mouseEventSource: nil, mouseType: .mouseMoved, mouseCursorPosition: point, mouseButton: .left)?.post(tap: .cghidEventTap)
  usleep(40_000)
  post(.leftMouseDown, 1)
  usleep(50_000)
  post(.leftMouseUp, 1)
  usleep(150_000)
  post(.leftMouseDown, 2)
  usleep(50_000)
  post(.leftMouseUp, 2)
  printJSON(["doubleClicked": true, "x": x, "y": y])

case "front":
  let raw = CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID) as? [[String: Any]] ?? []
  let top = raw.compactMap { windowInfo($0) }.first
  let app = NSWorkspace.shared.frontmostApplication
  let appInfo: [String: Any] = [
    "pid": Int(app?.processIdentifier ?? 0),
    "name": app?.localizedName ?? "",
    "bundleId": app?.bundleIdentifier ?? "",
  ]
  var out: [String: Any] = ["app": appInfo]
  if let top {
    out["window"] = top
  } else {
    out["window"] = NSNull()
  }
  printJSON(out)

case "activate":
  guard args.count >= 3, let pid = Int32(args[2]) else {
    fail("usage: macctl activate <pid> [窗口标题]")
  }
  NSRunningApplication(processIdentifier: pid_t(pid))?.activate(options: [.activateAllWindows])
  if args.count >= 4 {
    let needle = args[3]
    let app = AXUIElementCreateApplication(pid_t(pid))
    var windowsRef: CFTypeRef?
    if AXUIElementCopyAttributeValue(app, kAXWindowsAttribute as CFString, &windowsRef) == .success,
       let windows = windowsRef as? [AXUIElement] {
      for w in windows {
        var titleRef: CFTypeRef?
        AXUIElementCopyAttributeValue(w, kAXTitleAttribute as CFString, &titleRef)
        if ((titleRef as? String) ?? "").contains(needle) {
          AXUIElementPerformAction(w, kAXRaiseAction as CFString)
          break
        }
      }
    }
  }
  printJSON(["activated": true, "pid": Int(pid)])

case "raise":
  guard args.count >= 3 else { fail("usage: macctl raise <标题关键词>") }
  let needle = args[2]
  let raw = CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID) as? [[String: Any]] ?? []
  guard let target = raw.compactMap({ windowInfo($0) }).first(where: { (($0["title"] as? String) ?? "").contains(needle) }) else {
    fail("没找到标题包含 \(needle) 的窗口")
  }
  let pid = pid_t(target["pid"] as! Int)
  var raised = false
  let app = AXUIElementCreateApplication(pid)
  var windowsRef: CFTypeRef?
  if AXUIElementCopyAttributeValue(app, kAXWindowsAttribute as CFString, &windowsRef) == .success,
     let windows = windowsRef as? [AXUIElement] {
    for w in windows {
      var titleRef: CFTypeRef?
      AXUIElementCopyAttributeValue(w, kAXTitleAttribute as CFString, &titleRef)
      if ((titleRef as? String) ?? "").contains(needle) {
        AXUIElementPerformAction(w, kAXRaiseAction as CFString)
        AXUIElementSetAttributeValue(w, kAXMainAttribute as CFString, kCFBooleanTrue)
        raised = true
      }
    }
  }
  NSRunningApplication(processIdentifier: pid)?.activate(options: [.activateAllWindows])
  printJSON(["raised": raised, "id": target["id"]!, "pid": Int(pid)])

case "ocr":
  guard args.count >= 3 else { fail("usage: macctl ocr <png>") }
  let path = args[2]
  guard let image = NSImage(contentsOfFile: path),
        let cg = image.cgImage(forProposedRect: nil, context: nil, hints: nil) else {
    fail("cannot read image: \(path)")
  }
  let width = cg.width
  let height = cg.height
  let request = VNRecognizeTextRequest()
  request.recognitionLevel = .accurate
  request.recognitionLanguages = ["zh-Hans", "en-US"]
  request.usesLanguageCorrection = true
  let handler = VNImageRequestHandler(cgImage: cg, options: [:])
  do {
    try handler.perform([request])
  } catch {
    fail("ocr failed: \(error)")
  }
  var lines: [[String: Any]] = []
  for obs in request.results ?? [] {
    guard let candidate = obs.topCandidates(1).first else { continue }
    let bb = obs.boundingBox
    lines.append([
      "text": candidate.string,
      "confidence": Double(candidate.confidence),
      "x": Int((Double(bb.minX) * Double(width)).rounded()),
      "y": Int(((1 - Double(bb.maxY)) * Double(height)).rounded()),
      "w": Int((Double(bb.width) * Double(width)).rounded()),
      "h": Int((Double(bb.height) * Double(height)).rounded()),
    ])
  }
  printJSON(["image": ["width": width, "height": height], "lines": lines])

default:
  fail("unknown command: \(args[1])")
}
