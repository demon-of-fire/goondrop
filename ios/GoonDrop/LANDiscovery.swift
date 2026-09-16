import Foundation
import Darwin

/// Raw UDP broadcast discovery that finds Goon Drop PC servers on the same Wi-Fi.
///
/// The Goon Drop backend listens on UDP port 3943 and answers `goondrop_discover`
/// packets with a JSON payload containing `{ ip, port, pairingCode, serverName }`.
/// We send the broadcast, then read unicast replies straight back on the same socket.
enum LANDiscovery {

    /// Broadcast `goondrop_discover` on UDP 3943 and collect every server that replies.
    /// Runs synchronously (blocking) — call from a background task.
    static func discover(timeout: TimeInterval = 2.5) -> [DiscoveredServer] {
        let fd = socket(AF_INET, SOCK_DGRAM, IPPROTO_UDP)
        guard fd >= 0 else { return [] }
        defer { close(fd) }

        var broadcast: Int32 = 1
        setsockopt(fd, SOL_SOCKET, SO_BROADCAST, &broadcast, socklen_t(MemoryLayout<Int32>.size))

        // Bind to an ephemeral local port so we receive the unicast replies.
        var bindAddr = sockaddr_in()
        bindAddr.sin_family = sa_family_t(AF_INET)
        bindAddr.sin_port = 0
        bindAddr.sin_addr.s_addr = INADDR_ANY
        let bindOK = withUnsafePointer(to: &bindAddr) { ptr in
            ptr.withMemoryRebound(to: sockaddr.self, capacity: 1) { addr in
                bind(fd, addr, socklen_t(MemoryLayout<sockaddr_in>.size)) == 0
            }
        }
        guard bindOK else { return [] }

        // Short receive timeout so the loop can check the deadline while waiting.
        var tv = timeval(tv_sec: 0, tv_usec: 400_000)
        setsockopt(fd, SOL_SOCKET, SO_RCVTIMEO, &tv, socklen_t(MemoryLayout<timeval>.size))

        let message = "goondrop_discover"
        let bytes = Array(message.utf8)

        var dest = sockaddr_in()
        dest.sin_family = sa_family_t(AF_INET)
        dest.sin_port = UInt16(3943).bigEndian
        dest.sin_addr.s_addr = inet_addr("255.255.255.255")

        let sent = bytes.withUnsafeBufferPointer { buf in
            withUnsafePointer(to: &dest) { ptr in
                ptr.withMemoryRebound(to: sockaddr.self, capacity: 1) { addr in
                    sendto(fd, buf.baseAddress, buf.count, 0, addr, socklen_t(MemoryLayout<sockaddr_in>.size))
                }
            }
        }
        guard sent >= 0 else { return [] }

        let deadline = Date().addingTimeInterval(timeout)
        var results: [DiscoveredServer] = []
        var buffer = [UInt8](repeating: 0, count: 2048)

        while Date() < deadline {
            let n = recv(fd, &buffer, buffer.count, 0)
            if n < 0 {
                if errno == EAGAIN || errno == EWOULDBLOCK { continue }
                break
            }
            let data = Data(buffer[0..<n])
            if let server = try? JSONDecoder().decode(DiscoveredServer.self, from: data),
               !results.contains(server) {
                results.append(server)
            }
        }
        return results
    }
}