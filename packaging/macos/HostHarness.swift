// Qualification-only executable. Never copied into the app or disk image.
import Foundation

@main struct HostHarness {
    static func main() {
        guard CommandLine.arguments.count == 3 else { exit(2) }
        let host = RuntimeHost()
        func emit(_ value: [String: String]) {
            let bytes = try! JSONSerialization.data(withJSONObject: value)
            FileHandle.standardOutput.write(bytes + Data([10]))
        }
        host.onReady = { url in emit(["type": "ready", "url": url.absoluteString]) }
        host.onFailure = { failure in
            emit(["type": "error", "code": failure.rawValue])
            host.stop { exit(1) }
        }
        do {
            try host.start(bundle: URL(fileURLWithPath: CommandLine.arguments[1]),
                           data: URL(fileURLWithPath: CommandLine.arguments[2]))
        } catch {
            emit(["type": "error", "code": (error as? HostFailure)?.rawValue ?? "LOCAL_RUNTIME_START_FAILED"])
            exit(1)
        }
        DispatchQueue.global().async {
            _ = readLine()
            DispatchQueue.main.async { host.stop { exit(0) } }
        }
        RunLoop.main.run()
    }
}
