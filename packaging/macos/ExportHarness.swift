// Qualification-only executable; never included in the app.
import Foundation
import Darwin

@main struct ExportHarness {
    static func main() throws {
        let root = URL(fileURLWithPath: CommandLine.arguments[1])
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: false, attributes: [.posixPermissions: 0o700])
        let dest = root.appendingPathComponent("evidence.json")
        let pending = try PrivateExport(destination: dest)
        try Data("fictional export".utf8).write(to: pending.temporary)
        try pending.publish()
        var info = stat()
        precondition(lstat(dest.path, &info) == 0 && (info.st_mode & 0o777) == 0o600)
        let original = try String(contentsOf: dest)
        precondition(original == "fictional export")
        let duplicate = try PrivateExport(destination: dest)
        try Data("must not replace".utf8).write(to: duplicate.temporary)
        do { try duplicate.publish(); fatalError("existing destination was replaced") } catch { duplicate.cleanup() }
        let afterDuplicate = try String(contentsOf: dest)
        precondition(afterDuplicate == original)
        let link = root.appendingPathComponent("linked.json")
        try FileManager.default.createSymbolicLink(at: link, withDestinationURL: dest)
        let unsafe = try PrivateExport(destination: link)
        try Data("must not follow".utf8).write(to: unsafe.temporary)
        do { try unsafe.publish(); fatalError("symlink was replaced") } catch { unsafe.cleanup() }
        let afterLink = try String(contentsOf: dest)
        precondition(afterLink == original)
        print("Private export mode and no-overwrite checks passed")
    }
}
