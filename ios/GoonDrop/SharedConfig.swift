import Foundation
import Combine
import Security
import CryptoKit

/// Centralized configuration shared between the main Goon Drop app and the Share Sheet extension.
/// Uses App Groups (`group.com.goondrop.app`) so preferences set in the app are immediately
/// accessible to the iOS Share Sheet extension.
public class SharedConfig: ObservableObject {
    public static let shared = SharedConfig()
    
    public static let appGroupName = "group.com.goondrop.app"
    
    private var defaults: UserDefaults {
        return UserDefaults(suiteName: SharedConfig.appGroupName) ?? UserDefaults.standard
    }
    
    private let keyServerHost = "goondrop_server_host"
    private let keyServerPort = "goondrop_server_port"
    private let keyUseHttps   = "goondrop_use_https"
    private let keyPairingCode = "goondrop_pairing_code"
    private let keyAutoSend    = "goondrop_auto_send"
    private let keyServerName  = "goondrop_server_name"
    private let keyConfigured  = "goondrop_configured"
    
    @Published public var serverHost: String {
        didSet {
            defaults.set(serverHost.trimmingCharacters(in: .whitespacesAndNewlines), forKey: keyServerHost)
        }
    }
    
    @Published public var serverPort: Int {
        didSet {
            defaults.set(serverPort, forKey: keyServerPort)
        }
    }
    
    @Published public var useHttps: Bool {
        didSet {
            defaults.set(useHttps, forKey: keyUseHttps)
        }
    }
    
    @Published public var pairingCode: String {
        didSet {
            defaults.set(pairingCode.trimmingCharacters(in: .whitespacesAndNewlines), forKey: keyPairingCode)
        }
    }
    
    @Published public var autoSend: Bool {
        didSet {
            defaults.set(autoSend, forKey: keyAutoSend)
        }
    }

    @Published public var serverName: String {
        didSet {
            defaults.set(serverName, forKey: keyServerName)
        }
    }

    /// True once the user has picked a server (via Wi-Fi discovery or manual entry).
    /// Until then the app shows the discovery screen instead of trying a placeholder IP.
    @Published public var isConfigured: Bool {
        didSet {
            defaults.set(isConfigured, forKey: keyConfigured)
        }
    }
    
    private init() {
        let defs = UserDefaults(suiteName: SharedConfig.appGroupName) ?? UserDefaults.standard
        let host = defs.string(forKey: keyServerHost) ?? "192.168.1.100"
        let port = defs.integer(forKey: keyServerPort)
        let https = defs.object(forKey: keyUseHttps) as? Bool ?? true
        let code = defs.string(forKey: keyPairingCode) ?? ""
        let auto = defs.object(forKey: keyAutoSend) as? Bool ?? true
        let name = defs.string(forKey: keyServerName) ?? ""
        let configured = defs.object(forKey: keyConfigured) as? Bool ?? false
        
        self.serverHost = host
        self.serverPort = port > 0 ? port : 3942
        self.useHttps = https
        self.pairingCode = code
        self.autoSend = auto
        self.serverName = name
        self.isConfigured = configured
    }
    
    public var baseURLString: String {
        let scheme = useHttps ? "https" : "http"
        return "\(scheme)://\(serverHost):\(serverPort)"
    }

    public var wsURL: URL? {
        let scheme = useHttps ? "wss" : "ws"
        return URL(string: "\(scheme)://\(serverHost):\(serverPort)/")
    }
    
    public var apiDropURL: URL? {
        URL(string: "\(baseURLString)/api/drop")
    }
    
    public var apiDropResumeURL: URL? {
        URL(string: "\(baseURLString)/api/drop/resume")
    }
    
    public var apiHandoffURL: URL? {
        URL(string: "\(baseURLString)/api/handoff")
    }
    
    public var apiClipboardURL: URL? {
        URL(string: "\(baseURLString)/api/clipboard")
    }
    
    public var apiClipboardRestoreURL: URL? {
        URL(string: "\(baseURLString)/api/clipboard/restore")
    }
    
    public var apiHealthURL: URL? {
        URL(string: "\(baseURLString)/api/health")
    }
    
    /// Create a URLSession configured to trust local self-signed certificates for LAN transfer
    public static func makeLANSession() -> URLSession {
        let config = URLSessionConfiguration.default
        config.timeoutIntervalForRequest = 30
        config.timeoutIntervalForResource = 300
        return URLSession(configuration: config, delegate: LANTrustSessionDelegate(), delegateQueue: nil)
    }
}

/// Tracks the TLS certificate fingerprint the app first saw for each PC (TOFU).
/// A change usually means the PC regenerated its cert; diagnostics surfaces it
/// so the user can re-trust rather than silently talking to something new.
enum ServerCertStore {
    private static let prefix = "goondrop_cert_fp_"

    private static var defaults: UserDefaults {
        UserDefaults(suiteName: SharedConfig.appGroupName) ?? .standard
    }

    private static func key(_ host: String, _ port: Int) -> String {
        "\(prefix)\(host):\(port)"
    }

    static func knownFingerprint(host: String, port: Int) -> String? {
        defaults.string(forKey: key(host, port))
    }

    /// Record the observed fingerprint. Returns true when it differs from a
    /// previously stored value (a potential MITM or regenerated cert).
    @discardableResult
    static func observe(host: String, port: Int, fingerprint: String) -> Bool {
        let existing = knownFingerprint(host: host, port: port)
        if existing == nil {
            defaults.set(fingerprint, forKey: key(host, port))
            return false
        }
        return existing != fingerprint
    }
}

/// URLSession delegate that accepts local self-signed SSL certificates generated by Goon Drop
public class LANTrustSessionDelegate: NSObject, URLSessionDelegate {
    public func urlSession(
        _ session: URLSession,
        didReceive challenge: URLAuthenticationChallenge,
        completionHandler: @escaping (URLSession.AuthChallengeDisposition, URLCredential?) -> Void
    ) {
        if challenge.protectionSpace.authenticationMethod == NSURLAuthenticationMethodServerTrust,
           let serverTrust = challenge.protectionSpace.serverTrust {
            // Capture the leaf certificate fingerprint (trust on first use).
            if let chain = SecTrustCopyCertificateChain(serverTrust) as? [SecCertificate],
               let leaf = chain.first {
                let data = SecCertificateCopyData(leaf) as Data
                let digest = SHA256.hash(data: data)
                let fingerprint = digest.map { String(format: "%02x", $0) }.joined()
                let space = challenge.protectionSpace
                ServerCertStore.observe(host: space.host, port: space.port, fingerprint: fingerprint)
            }
            // Local network self-signed certificate trust
            completionHandler(.useCredential, URLCredential(trust: serverTrust))
        } else {
            completionHandler(.performDefaultHandling, nil)
        }
    }
}
