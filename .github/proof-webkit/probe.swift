// Proof-only probe (hosted runner only). Usage: probe <nsapp:0|1> <seconds>
// Issues the WKWebsiteDataStore calls DashboardBrowserSessionStore makes, with idle gaps,
// and reports reply latency plus WebKit helper process states.
import AppKit
import Foundation
import WebKit

let startsApplication = CommandLine.arguments[1] == "1"
let seconds = Double(CommandLine.arguments[2]) ?? 240
let started = Date()

func helperStates() -> String {
    let process = Process()
    process.executableURL = URL(fileURLWithPath: "/bin/ps")
    process.arguments = ["-axo", "pid,stat,pcpu,comm"]
    let pipe = Pipe()
    process.standardOutput = pipe
    try? process.run()
    let data = pipe.fileHandleForReading.readDataToEndOfFile()
    process.waitUntilExit()
    return String(decoding: data, as: UTF8.self)
        .split(separator: "\n")
        .filter { $0.contains("com.apple.WebKit") }
        .map { line -> String in
            let fields = line.split(separator: " ", omittingEmptySubsequences: true)
            guard fields.count >= 4 else { return String(line) }
            return "\(fields[0]):\(fields[1]):\(fields[2]):\(fields[3].split(separator: ".").last ?? "")"
        }
        .joined(separator: " ")
}

func elapsed() -> String { String(format: "%6.1f", Date().timeIntervalSince(started)) }

Task { @MainActor in
    if startsApplication {
        let application = NSApplication.shared
        _ = application.setActivationPolicy(.accessory)
        application.finishLaunching()
        RunLoop.main.perform(inModes: [.common]) {
            MainActor.assumeIsolated { application.run() }
        }
    }
    let configuration = WKWebViewConfiguration()
    configuration.websiteDataStore = .nonPersistent()
    let store = configuration.websiteDataStore
    // One short-lived page makes WebKit launch its helpers, as the suite's earlier tests do.
    let webView = WKWebView(frame: .init(x: 0, y: 0, width: 200, height: 200), configuration: configuration)
    webView.loadHTMLString("<p>probe</p>", baseURL: URL(string: "https://probe.example.test/"))
    try? await Task.sleep(for: .seconds(2))
    var round = 0
    var worst = 0.0
    var slow = 0
    while Date().timeIntervalSince(started) < seconds {
        round += 1
        let idle = [1.0, 5.0, 20.0, 45.0][round % 4]
        try? await Task.sleep(for: .seconds(idle))
        let begin = Date()
        _ = await store.httpCookieStore.allCookies()
        await store.removeData(ofTypes: [WKWebsiteDataTypeServiceWorkerRegistrations], modifiedSince: .distantPast)
        let latency = Date().timeIntervalSince(begin)
        worst = max(worst, latency)
        if latency > 10 { slow += 1 }
        print("t=\(elapsed()) nsapp=\(startsApplication) idle=\(idle)s dataStoreLatency=\(String(format: "%.2f", latency))s helpers=[\(helperStates())]")
    }
    print("RESULT nsapp=\(startsApplication) rounds=\(round) worstLatency=\(String(format: "%.1f", worst))s slowOver10s=\(slow)")
    exit(0)
}

// A watchdog thread reports progress even if every data-store reply stalls.
Thread.detachNewThread {
    while true {
        Thread.sleep(forTimeInterval: 30)
        print("watchdog t=\(elapsed()) helpers=[\(helperStates())]")
        if Date().timeIntervalSince(started) > seconds + 120 {
            print("RESULT nsapp=\(startsApplication) STALLED: data-store reply never arrived")
            exit(4)
        }
    }
}

RunLoop.main.run()
