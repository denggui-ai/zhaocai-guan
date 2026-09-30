import AppKit
import Foundation

func fail(_ message: String) -> Never {
    FileHandle.standardError.write(Data((message + "\n").utf8))
    exit(1)
}

let arguments = CommandLine.arguments
guard arguments.count == 3,
      let pid = Int32(arguments[1]),
      pid > 0 else {
    fail("usage: quit-macos-candidate.swift <pid> <expected-app-path>")
}

let expectedPath = URL(fileURLWithPath: arguments[2])
    .resolvingSymlinksInPath().standardizedFileURL.path
guard let application = NSRunningApplication(processIdentifier: pid),
      application.bundleIdentifier == "io.talentbench.desktop",
      let bundleURL = application.bundleURL,
      bundleURL.resolvingSymlinksInPath().standardizedFileURL.path == expectedPath else {
    fail("candidate PID does not belong to the expected app bundle")
}

guard application.terminate() else {
    fail("candidate did not accept a normal quit request")
}
