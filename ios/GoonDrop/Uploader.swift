import Foundation

/// State of an outbound file transfer shown in the Send tab.
enum UploadState: Equatable {
    case waiting
    case uploading
    case done
    case failed(String)

    var label: String {
        switch self {
        case .waiting: return "Waiting"
        case .uploading: return "Sending"
        case .done: return "Sent"
        case .failed(let reason): return "Failed · \(reason)"
        }
    }
}

/// A file being pushed from the iPhone to the PC.
struct FileTransferOut: Identifiable, Equatable {
    let id: String
    var fileName: String
    var bytesSent: Int64
    var totalBytes: Int64
    var state: UploadState

    var progress: Double {
        guard totalBytes > 0 else { return 0 }
        return min(1, Double(bytesSent) / Double(totalBytes))
    }
}

/// Uploads a file with live progress, trusting the PC's self-signed LAN cert.
/// Kept separate so the URLSession delegate can report `didSendBodyData`.
final class Uploader: NSObject {
    private var session: URLSession?
    private var onProgress: ((Double, Int64, Int64) -> Void)?
    private var onComplete: ((Bool, String?) -> Void)?
    private var didFinish = false

    func start(
        request: URLRequest,
        fromFile fileURL: URL?,
        fromData data: Data?,
        onProgress: @escaping (Double, Int64, Int64) -> Void,
        onComplete: @escaping (Bool, String?) -> Void
    ) {
        self.onProgress = onProgress
        self.onComplete = onComplete

        let config = URLSessionConfiguration.default
        config.timeoutIntervalForRequest = 30
        config.timeoutIntervalForResource = 3600
        let session = URLSession(configuration: config, delegate: self, delegateQueue: nil)
        self.session = session

        let task: URLSessionUploadTask
        if let fileURL = fileURL {
            task = session.uploadTask(with: request, fromFile: fileURL)
        } else {
            task = session.uploadTask(with: request, from: data ?? Data())
        }
        task.resume()
    }

    func cancel() {
        session?.invalidateAndCancel()
        finish(ok: false, error: "Cancelled")
    }

    private func finish(ok: Bool, error: String?) {
        guard !didFinish else { return }
        didFinish = true
        onComplete?(ok, error)
        session?.finishTasksAndInvalidate()
        session = nil
    }
}

extension Uploader: URLSessionTaskDelegate, URLSessionDelegate {
    func urlSession(
        _ session: URLSession,
        task: URLSessionTask,
        didSendBodyData bytesSent: Int64,
        totalBytesSent: Int64,
        totalBytesExpectedToSend: Int64
    ) {
        guard totalBytesExpectedToSend > 0 else { return }
        onProgress?(
            Double(totalBytesSent) / Double(totalBytesExpectedToSend),
            totalBytesSent,
            totalBytesExpectedToSend
        )
    }

    func urlSession(_ session: URLSession, task: URLSessionTask, didCompleteWithError error: Error?) {
        if let error = error {
            finish(ok: false, error: error.localizedDescription)
            return
        }
        let code = (task.response as? HTTPURLResponse)?.statusCode ?? 0
        finish(ok: (200...299).contains(code), error: code == 0 ? "No response" : "HTTP \(code)")
    }

    func urlSession(
        _ session: URLSession,
        didReceive challenge: URLAuthenticationChallenge,
        completionHandler: @escaping (URLSession.AuthChallengeDisposition, URLCredential?) -> Void
    ) {
        if challenge.protectionSpace.authenticationMethod == NSURLAuthenticationMethodServerTrust,
           let serverTrust = challenge.protectionSpace.serverTrust {
            completionHandler(.useCredential, URLCredential(trust: serverTrust))
        } else {
            completionHandler(.performDefaultHandling, nil)
        }
    }
}
