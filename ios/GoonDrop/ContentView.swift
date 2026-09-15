import SwiftUI
import PhotosUI
import UniformTypeIdentifiers

struct ContentView: View {
    @ObservedObject var config = SharedConfig.shared
    
    @State private var isConnected = false
    @State private var isChecking = false
    @State private var showSettings = false
    @State private var reloadWebView = false
    @State private var statusMessage: String? = nil
    
    // Quick send states
    @State private var selectedPhotos: [PhotosPickerItem] = []
    @State private var showFileImporter = false
    @State private var isUploading = false
    @State private var uploadProgress: Double = 0.0
    
    var body: some View {
        NavigationView {
            VStack(spacing: 0) {
                // Connection Header
                HStack {
                    HStack(spacing: 8) {
                        Circle()
                            .fill(isConnected ? Color.green : Color.red)
                            .frame(width: 10, height: 10)
                        
                        VStack(alignment: .leading, spacing: 2) {
                            Text(isConnected ? "Connected to PC" : "Connecting...")
                                .font(.system(size: 13, weight: .semibold))
                            Text("\(config.serverHost):\(config.serverPort)")
                                .font(.system(size: 11))
                                .foregroundColor(.secondary)
                        }
                    }
                    
                    Spacer()
                    
                    Button(action: {
                        reloadWebView = true
                        checkConnection()
                    }) {
                        Image(systemName: "arrow.clockwise")
                            .font(.system(size: 14, weight: .medium))
                            .rotationEffect(.degrees(isChecking ? 360 : 0))
                            .animation(isChecking ? Animation.linear(duration: 1).repeatForever(autoreverses: false) : .default, value: isChecking)
                    }
                    .buttonStyle(.bordered)
                    .controlSize(.small)
                    
                    Button(action: { showSettings = true }) {
                        Image(systemName: "gearshape.fill")
                            .font(.system(size: 14, weight: .medium))
                    }
                    .buttonStyle(.bordered)
                    .controlSize(.small)
                }
                .padding(.horizontal, 16)
                .padding(.vertical, 10)
                .background(Color(UIColor.secondarySystemBackground))
                
                // Upload status banner (if active)
                if isUploading {
                    VStack(spacing: 4) {
                        ProgressView(value: uploadProgress, total: 1.0)
                            .progressViewStyle(LinearProgressViewStyle())
                        Text(statusMessage ?? "Uploading to PC...")
                            .font(.system(size: 11, weight: .medium))
                            .foregroundColor(.secondary)
                    }
                    .padding(.horizontal, 16)
                    .padding(.vertical, 6)
                    .background(Color.accentColor.opacity(0.1))
                } else if let msg = statusMessage {
                    Text(msg)
                        .font(.system(size: 11, weight: .medium))
                        .foregroundColor(.secondary)
                        .padding(.vertical, 4)
                }
                
                // Main Web Dashboard
                if let url = URL(string: config.baseURLString) {
                    WebViewContainer(url: url, reloadTrigger: $reloadWebView)
                        .edgesIgnoringSafeArea(.bottom)
                } else {
                    Text("Invalid server URL")
                        .foregroundColor(.red)
                }
            }
            .navigationBarHidden(true)
            .sheet(isPresented: $showSettings) {
                SettingsView(config: config, onSave: {
                    reloadWebView = true
                    checkConnection()
                })
            }
            .onChange(of: selectedPhotos) { newItems in
                handlePhotoSelection(newItems)
            }
            .fileImporter(
                isPresented: $showFileImporter,
                allowedContentTypes: [.item],
                allowsMultipleSelection: true
            ) { result in
                handleFileSelection(result)
            }
            .onAppear {
                checkConnection()
            }
        }
        .navigationViewStyle(StackNavigationViewStyle())
    }
    
    // Check health endpoint on PC
    func checkConnection() {
        guard let healthURL = config.apiHealthURL else { return }
        isChecking = true
        
        let session = SharedConfig.makeLANSession()
        var request = URLRequest(url: healthURL, timeoutInterval: 4)
        if !config.pairingCode.isEmpty {
            request.setValue(config.pairingCode, forHTTPHeaderField: "x-goondrop-code")
        }
        
        session.dataTask(with: request) { data, response, error in
            DispatchQueue.main.async {
                self.isChecking = false
                if let http = response as? HTTPURLResponse, (200...299).contains(http.statusCode) {
                    self.isConnected = true
                } else {
                    self.isConnected = false
                }
            }
        }.resume()
    }
    
    // Quick send photos
    func handlePhotoSelection(_ items: [PhotosPickerItem]) {
        guard !items.isEmpty else { return }
        isUploading = true
        statusMessage = "Preparing \(items.count) photo(s)..."
        
        Task {
            for (index, item) in items.enumerated() {
                if let data = try? await item.loadTransferable(type: Data.self) {
                    let fileName = "photo_\(Date().timeIntervalSince1970)_\(index).jpg"
                    await uploadFile(data: data, fileName: fileName, mimeType: "image/jpeg")
                }
            }
            DispatchQueue.main.async {
                self.selectedPhotos = []
                self.isUploading = false
                self.statusMessage = "Photos sent to PC!"
                DispatchQueue.main.asyncAfter(deadline: .now() + 3) {
                    self.statusMessage = nil
                }
            }
        }
    }
    
    // Quick send files
    func handleFileSelection(_ result: Result<[URL], Error>) {
        switch result {
        case .success(let urls):
            isUploading = true
            statusMessage = "Sending \(urls.count) file(s)..."
            Task {
                for url in urls {
                    guard url.startAccessingSecurityScopedResource() else { continue }
                    defer { url.stopAccessingSecurityScopedResource() }
                    if let data = try? Data(contentsOf: url) {
                        await uploadFile(data: data, fileName: url.lastPathComponent, mimeType: "application/octet-stream")
                    }
                }
                DispatchQueue.main.async {
                    self.isUploading = false
                    self.statusMessage = "Files sent to PC!"
                    DispatchQueue.main.asyncAfter(deadline: .now() + 3) {
                        self.statusMessage = nil
                    }
                }
            }
        case .failure(let error):
            self.statusMessage = "File error: \(error.localizedDescription)"
        }
    }
    
    // Multipart upload to /api/drop
    func uploadFile(data: Data, fileName: String, mimeType: String) async {
        guard let url = config.apiDropURL else { return }
        let boundary = "Boundary-\(UUID().uuidString)"
        
        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        request.setValue("multipart/form-data; boundary=\(boundary)", forHTTPHeaderField: "Content-Type")
        if !config.pairingCode.isEmpty {
            request.setValue(config.pairingCode, forHTTPHeaderField: "x-goondrop-code")
        }
        
        var body = Data()
        body.append("--\(boundary)\r\n".data(using: .utf8)!)
        body.append("Content-Disposition: form-data; name=\"file\"; filename=\"\(fileName)\"\r\n".data(using: .utf8)!)
        body.append("Content-Type: \(mimeType)\r\n\r\n".data(using: .utf8)!)
        body.append(data)
        body.append("\r\n--\(boundary)--\r\n".data(using: .utf8)!)
        
        let session = SharedConfig.makeLANSession()
        do {
            let (_, response) = try await session.upload(for: request, from: body)
            if let http = response as? HTTPURLResponse, (200...299).contains(http.statusCode) {
                print("[GoonDrop] Successfully dropped: \(fileName)")
            }
        } catch {
            print("[GoonDrop] Upload error: \(error.localizedDescription)")
        }
    }
}

struct SettingsView: View {
    @ObservedObject var config: SharedConfig
    let onSave: () -> Void
    @Environment(\.presentationMode) var presentationMode
    
    @State private var host: String = ""
    @State private var port: String = ""
    @State private var useHttps: Bool = true
    @State private var code: String = ""
    
    var body: some View {
        NavigationView {
            Form {
                Section(header: Text("PC Server Settings")) {
                    HStack {
                        Text("PC IP Address")
                        Spacer()
                        TextField("e.g. 192.168.1.100", text: $host)
                            .multilineTextAlignment(.trailing)
                            .autocapitalization(.none)
                            .disableAutocorrection(true)
                            .keyboardType(.numbersAndPunctuation)
                    }
                    
                    HStack {
                        Text("Port")
                        Spacer()
                        TextField("3942", text: $port)
                            .multilineTextAlignment(.trailing)
                            .keyboardType(.numberPad)
                    }
                    
                    Toggle("Use HTTPS (Default port 3942)", isOn: $useHttps)
                    
                    HStack {
                        Text("Pairing Code")
                        Spacer()
                        TextField("Optional", text: $code)
                            .multilineTextAlignment(.trailing)
                            .autocapitalization(.allCharacters)
                    }
                }
                
                Section(header: Text("Share Sheet Info")) {
                    Text("These settings are shared with the iOS Share Sheet extension. Whenever you share any photo, file, or Safari link, it sends directly to this PC address.")
                        .font(.footnote)
                        .foregroundColor(.secondary)
                }
            }
            .navigationTitle("Server Connection")
            .navigationBarItems(
                leading: Button("Cancel") {
                    presentationMode.wrappedValue.dismiss()
                },
                trailing: Button("Save") {
                    config.serverHost = host
                    if let p = Int(port), p > 0 {
                        config.serverPort = p
                    }
                    config.useHttps = useHttps
                    config.pairingCode = code
                    onSave()
                    presentationMode.wrappedValue.dismiss()
                }
            )
            .onAppear {
                host = config.serverHost
                port = String(config.serverPort)
                useHttps = config.useHttps
                code = config.pairingCode
            }
        }
    }
}
