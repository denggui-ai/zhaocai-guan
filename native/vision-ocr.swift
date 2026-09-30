import AppKit
import Foundation
import Vision

struct OcrLine: Codable {
  let text: String
  let confidence: Float
  let left: Double
  let top: Double
  let width: Double
  let height: Double
}

struct OcrImage: Codable {
  let file: String
  let width: Double
  let height: Double
  let lines: [OcrLine]
  let error: String?
}

func cgImage(from path: String) throws -> (CGImage, Double, Double) {
  let url = URL(fileURLWithPath: path)
  guard let image = NSImage(contentsOf: url) else {
    throw NSError(domain: "VisionOCR", code: 1, userInfo: [NSLocalizedDescriptionKey: "cannot open image"])
  }
  var rect = CGRect(origin: .zero, size: image.size)
  guard let cg = image.cgImage(forProposedRect: &rect, context: nil, hints: nil) else {
    throw NSError(domain: "VisionOCR", code: 2, userInfo: [NSLocalizedDescriptionKey: "cannot create CGImage"])
  }
  return (cg, Double(cg.width), Double(cg.height))
}

func recognize(path: String) -> OcrImage {
  do {
    let (cg, pixelWidth, pixelHeight) = try cgImage(from: path)
    let request = VNRecognizeTextRequest()
    request.recognitionLevel = .accurate
    request.usesLanguageCorrection = true
    request.recognitionLanguages = ["zh-Hans", "en-US"]
    let handler = VNImageRequestHandler(cgImage: cg, options: [:])
    try handler.perform([request])
    let lines = (request.results ?? []).compactMap { observation -> OcrLine? in
      guard let candidate = observation.topCandidates(1).first else { return nil }
      let box = observation.boundingBox
      return OcrLine(
        text: candidate.string,
        confidence: candidate.confidence,
        left: Double(box.origin.x) * pixelWidth,
        top: (1.0 - Double(box.origin.y) - Double(box.height)) * pixelHeight,
        width: Double(box.width) * pixelWidth,
        height: Double(box.height) * pixelHeight
      )
    }.sorted {
      if abs($0.top - $1.top) > 10 { return $0.top < $1.top }
      return $0.left < $1.left
    }
    return OcrImage(file: path, width: pixelWidth, height: pixelHeight, lines: lines, error: nil)
  } catch {
    return OcrImage(file: path, width: 0, height: 0, lines: [], error: error.localizedDescription)
  }
}

// Recognition is the long pole of a screenshot import, so report after every
// page. The parent is blocked in spawnSync and cannot relay this itself; the
// action server reads the file while the batch runs.
func writeProgress(to path: String?, done: Int, total: Int) {
  guard let path, !path.isEmpty else { return }
  let payload = "{\"done\":\(done),\"total\":\(total)}"
  try? Data(payload.utf8).write(to: URL(fileURLWithPath: path), options: .atomic)
}

let arguments = Array(CommandLine.arguments.dropFirst())
let progressPath = arguments
  .first { $0.hasPrefix("--progress=") }
  .map { String($0.dropFirst("--progress=".count)) }
let paths = arguments.filter { !$0.hasPrefix("--") }

writeProgress(to: progressPath, done: 0, total: paths.count)

// Recognition is per-image and independent, and the machine has more than one
// core, so the images are read in parallel. Results are written into their own
// slot rather than appended: the order of the output is the order of the input,
// which is what the caller groups candidates by.
//
// The counter and the progress file are touched under a lock — several images
// finish at once, and a torn count would show the HR the batch going backwards.
var results = [OcrImage?](repeating: nil, count: paths.count)
let lock = NSLock()
var done = 0

DispatchQueue.concurrentPerform(iterations: paths.count) { index in
  let recognized = recognize(path: paths[index])
  lock.lock()
  results[index] = recognized
  done += 1
  let completed = done
  writeProgress(to: progressPath, done: completed, total: paths.count)
  lock.unlock()
}

let ordered = results.compactMap { $0 }
guard ordered.count == paths.count else {
  FileHandle.standardError.write(Data("vision-ocr: 识别结果数量与输入不一致。\n".utf8))
  exit(1)
}
let encoder = JSONEncoder()
encoder.outputFormatting = [.prettyPrinted, .sortedKeys]
let data = try encoder.encode(ordered)
FileHandle.standardOutput.write(data)
