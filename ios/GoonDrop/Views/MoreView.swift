import SwiftUI

/// Overflow screen. Keeps the tab bar at a comfortable five items while leaving
/// every feature one tap away instead of buried in the system "More" menu.
struct MoreView: View {
    @ObservedObject private var client = GoonDropClient.shared

    var body: some View {
        List {
            Section {
                NavigationLink {
                    HandoffView()
                } label: {
                    Label("Handoff links", systemImage: "link")
                }

                NavigationLink {
                    ChatView()
                } label: {
                    Label("Chat", systemImage: "bubble.left.and.bubble.right.fill")
                }

                NavigationLink {
                    NotesView()
                } label: {
                    Label("Notes & checklist", systemImage: "checklist")
                }

                NavigationLink {
                    ControlView()
                } label: {
                    Label("PC control", systemImage: "cursorarrow.click.2")
                }

                NavigationLink {
                    DiagnosticsView()
                } label: {
                    Label("Diagnostics", systemImage: "stethoscope")
                }
            } header: {
                Text("Tools")
            }

            Section {
                NavigationLink {
                    SettingsView()
                } label: {
                    Label("Settings", systemImage: "gearshape.fill")
                }
            } footer: {
                if client.isConnected {
                    LabeledContent("Connected to", value: client.serverName.isEmpty ? "PC" : client.serverName)
                } else {
                    Text("Not connected to a PC.")
                }
            }
        }
        .navigationTitle("More")
    }
}
