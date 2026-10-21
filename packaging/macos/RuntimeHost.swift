import Foundation
import Darwin

enum HostFailure: String, Error {
    case unsafeData = "PRIVATE_DATA_DIRECTORY_REQUIRED"
    case alreadyRunning = "WORKSPACE_ALREADY_OPEN"
    case launch = "LOCAL_RUNTIME_START_FAILED"
    case stopped = "LOCAL_RUNTIME_STOPPED"
}

/// The OS lock survives stale lock files and is released on process exit.
/// No PID-file reaping, shell execution, shared credentials or inherited runtime flags.
final class RuntimeHost {
    private var lockFD: Int32 = -1
    private var process: Process?
    private var input: Pipe?
    private var output: Pipe?
    private var buffer = Data()
    private var ready = false
    private var stopping = false
    private var timeout: DispatchWorkItem?
    private var stopped: (() -> Void)?
    var onReady: ((URL) -> Void)?
    var onFailure: ((HostFailure) -> Void)?

    func start(bundle: URL, data: URL) throws {
        guard process == nil, data.isFileURL, data.path.hasPrefix("/") else { throw HostFailure.launch }
        try FileManager.default.createDirectory(at: data, withIntermediateDirectories: true,
                                                attributes: [.posixPermissions: 0o700])
        var info = stat()
        guard lstat(data.path, &info) == 0, (info.st_mode & S_IFMT) == S_IFDIR,
              info.st_uid == geteuid(), (info.st_mode & 0o077) == 0 else { throw HostFailure.unsafeData }
        lockFD = open(data.appendingPathComponent("desktop.lock").path,
                      O_RDWR | O_CREAT | O_NOFOLLOW | O_CLOEXEC, 0o600)
        guard lockFD >= 0 else { throw HostFailure.unsafeData }
        guard fstat(lockFD, &info) == 0, (info.st_mode & S_IFMT) == S_IFREG,
              info.st_uid == geteuid(), info.st_nlink == 1, (info.st_mode & 0o077) == 0 else {
            releaseLock(); throw HostFailure.unsafeData
        }
        guard flock(lockFD, LOCK_EX | LOCK_NB) == 0 else {
            releaseLock(); throw HostFailure.alreadyRunning
        }
        let child = Process(), incoming = Pipe(), outgoing = Pipe()
        child.executableURL = bundle.appendingPathComponent("Contents/MacOS/CorestrumRuntime")
        child.arguments = ["--data-dir", data.path]
        child.currentDirectoryURL = bundle.appendingPathComponent("Contents/Resources")
        child.environment = ["PATH": "/usr/bin:/bin", "TMPDIR": NSTemporaryDirectory(), "LANG": "en_US.UTF-8"]
        child.standardInput = incoming
        child.standardOutput = outgoing
        // dup2 keeps the same flock open-file description alive in the child.
        // If the GUI crashes, a second GUI cannot open this workspace while the
        // old runtime is still exiting on stdin EOF. This is not a public log.
        child.standardError = FileHandle(fileDescriptor: lockFD, closeOnDealloc: false)
        input = incoming; output = outgoing; process = child
        outgoing.fileHandleForReading.readabilityHandler = { [weak self] handle in
            let bytes = handle.availableData
            DispatchQueue.main.async { self?.receive(bytes) }
        }
        child.terminationHandler = { [weak self] _ in
            DispatchQueue.main.async { self?.didStop() }
        }
        do { try child.run() } catch {
            outgoing.fileHandleForReading.readabilityHandler = nil
            process = nil; input = nil; output = nil; releaseLock()
            throw HostFailure.launch
        }
        let deadline = DispatchWorkItem { [weak self] in
            guard let self = self, !self.ready, !self.stopping else { return }
            self.onFailure?(.launch); self.stop()
        }
        timeout = deadline
        DispatchQueue.main.asyncAfter(deadline: .now() + 15, execute: deadline)
    }

    private func receive(_ bytes: Data) {
        guard !stopping, !ready, !bytes.isEmpty else { return }
        buffer.append(bytes)
        guard buffer.count <= 4096 else { onFailure?(.launch); stop(); return }
        guard let newline = buffer.firstIndex(of: 10) else { return }
        let line = buffer[..<newline]
        guard let object = try? JSONSerialization.jsonObject(with: Data(line)) as? [String: String],
              object.count == 2, object["type"] == "ready", let text = object["url"],
              let url = URL(string: text), let parts = URLComponents(url: url, resolvingAgainstBaseURL: false),
              parts.scheme == "http", parts.host == "127.0.0.1", let port = parts.port, port > 0,
              parts.user == nil, parts.password == nil, parts.path == "/", parts.query == nil,
              let fragment = parts.fragment, fragment.range(of: "^launch=[A-Za-z0-9_-]{43}$", options: .regularExpression) != nil
        else { onFailure?(.launch); stop(); return }
        buffer.removeAll(keepingCapacity: false)
        ready = true; timeout?.cancel(); onReady?(url)
    }

    func stop(completion: (() -> Void)? = nil) {
        if let completion = completion { stopped = completion }
        guard let child = process else { releaseLock(); stopped?(); stopped = nil; return }
        if stopping { return }
        stopping = true; timeout?.cancel()
        try? input?.fileHandleForWriting.close()
        if child.isRunning { child.terminate() }
        DispatchQueue.main.asyncAfter(deadline: .now() + 5) { [weak self, weak child] in
            guard self?.stopping == true, let child = child, child.isRunning else { return }
            kill(child.processIdentifier, SIGKILL)
        }
    }

    private func didStop() {
        let expected = stopping
        timeout?.cancel()
        output?.fileHandleForReading.readabilityHandler = nil
        try? input?.fileHandleForWriting.close()
        try? output?.fileHandleForReading.close()
        process = nil; input = nil; output = nil
        releaseLock()
        if !expected { onFailure?(.stopped) }
        stopped?(); stopped = nil
    }
    private func releaseLock() { if lockFD >= 0 { close(lockFD); lockFD = -1 } }
    deinit { releaseLock() }
}
