//
//  AppDelegate.swift
//  macOS (App)
//

import Cocoa

@main
class AppDelegate: NSObject, NSApplicationDelegate {

    func applicationDidFinishLaunching(_ notification: Notification) {
        // Automatic termination quits an app AppKit considers unused. That
        // exit has no crash report. The setup window is the app, so stay up.
        ProcessInfo.processInfo.disableAutomaticTermination("Setup window is open")
        ProcessInfo.processInfo.disableSuddenTermination()
        DispatchQueue.main.async {
            self.styleMainWindow()
        }
    }

    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool {
        true
    }

    private func styleMainWindow() {
        // windows.first can be a WebKit helper. Style the setup window.
        guard let window = NSApp.windows.first(where: { $0.contentViewController is ViewController })
            ?? NSApp.mainWindow
            ?? NSApp.windows.first else { return }

        window.titleVisibility = .hidden
        window.titlebarAppearsTransparent = true
        window.styleMask.insert(.fullSizeContentView)
        window.styleMask.insert(.resizable)
        window.isOpaque = false
        window.backgroundColor = .clear
        window.hasShadow = true
        window.isMovableByWindowBackground = true

        // Tall enough for the onboarding steps. The page scrolls if it doesn't fit.
        let size = NSSize(width: 420, height: 640)
        window.setContentSize(size)
        window.minSize = NSSize(width: 360, height: 480)
        window.center()
        window.makeKeyAndOrderFront(nil)

        if let content = window.contentView {
            content.wantsLayer = true
            content.layer?.backgroundColor = NSColor.clear.cgColor
        }
    }
}
