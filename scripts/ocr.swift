import Foundation
import Vision
import ImageIO

struct Line: Codable {
    let text: String
    let confidence: Float
    let x: CGFloat
    let y: CGFloat
    let width: CGFloat
    let height: CGFloat
}
do {
    guard CommandLine.arguments.count == 2 else { throw NSError(domain: "RUNLOG", code: 1) }
    let url = URL(fileURLWithPath: CommandLine.arguments[1])
    guard let source = CGImageSourceCreateWithURL(url as CFURL, nil),
          let image = CGImageSourceCreateImageAtIndex(source, 0, nil) else {
        throw NSError(domain: "RUNLOG", code: 2)
    }
    let request = VNRecognizeTextRequest()
    request.recognitionLevel = .accurate
    request.recognitionLanguages = ["en-US", "ru-RU"]
    request.usesLanguageCorrection = false
    let properties = CGImageSourceCopyPropertiesAtIndex(source, 0, nil) as? [CFString: Any]
    let rawOrientation = (properties?[kCGImagePropertyOrientation] as? NSNumber)?.uint32Value ?? 1
    let orientation = CGImagePropertyOrientation(rawValue: rawOrientation) ?? .up
    try VNImageRequestHandler(cgImage: image, orientation: orientation).perform([request])
    let lines = (request.results ?? []).compactMap { observation -> Line? in
        guard let candidate = observation.topCandidates(1).first else { return nil }
        let r = observation.boundingBox
        return Line(text: candidate.string, confidence: candidate.confidence,
                    x: r.minX, y: 1 - r.maxY, width: r.width, height: r.height)
    }.sorted { $0.y == $1.y ? $0.x < $1.x : $0.y < $1.y }
    FileHandle.standardOutput.write(try JSONEncoder().encode(lines))
} catch {
    FileHandle.standardError.write(Data("Local text recognition failed.\n".utf8))
    exit(1)
}
