import Foundation
import Darwin

/// WebKit writes into a private directory first. The user-visible file is only
/// published after restrictive permissions are applied, with no-overwrite rename.
final class PrivateExport {
    let directory: URL
    let temporary: URL
    let destination: URL
    init(destination: URL) throws {
        self.destination = destination
        directory = FileManager.default.temporaryDirectory.appendingPathComponent("corestrum-export-" + UUID().uuidString)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: false,
                                               attributes: [.posixPermissions: 0o700])
        temporary = directory.appendingPathComponent("export.json")
    }
    func publish() throws {
        guard chmod(temporary.path, 0o600) == 0 else { throw CocoaError(.fileWriteNoPermission) }
        let staging = destination.deletingLastPathComponent().appendingPathComponent(".corestrum-export-" + UUID().uuidString)
        try FileManager.default.createDirectory(at: staging, withIntermediateDirectories: false,
                                               attributes: [.posixPermissions: 0o700])
        defer { try? FileManager.default.removeItem(at: staging); cleanup() }
        let file = staging.appendingPathComponent("export.json")
        try FileManager.default.copyItem(at: temporary, to: file)
        guard chmod(file.path, 0o600) == 0,
              renamex_np(file.path, destination.path, UInt32(RENAME_EXCL)) == 0 else {
            throw CocoaError(.fileWriteUnknown)
        }
    }
    func cleanup() { try? FileManager.default.removeItem(at: directory) }
}
