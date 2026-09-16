import Foundation
import Darwin

/// Raw UDP broadcast discovery that finds Goon Drop PC servers on the same Wi-Fi.
///
/// The Goon Drop backend listens on UDP port 3943 and answers `goondrop_discover`
/// packets with a JSON payload containing `{ ip, port, pairingCode, serverName }`.
/// We send the broadcast, then read unicast replies straight back on the same socket.
///
/// Some networks / iOS versions never deliver phone→PC UDP broadcasts (the packet
/// dies before it leaves the phone or at the router) even though unicast TCP traffic
/// works fine. So when UDP finds nothing we ALSO sweep the local subnet over plain
/// HTTP: any host answering `GET /api/qrcode` on port 3941 is a Goon Drop PC. That
/// uses the exact transport that is proven to work on the network in question.
enum LANDiscovery {

    /// Discover Goon Drop servers: UDP broadcast + unicast HTTP subnet scan in
    /// parallel for speed, deduped. Runs synchronously (blocking) — call from a
    /// background task.
    static func discover(timeout: TimeInterval = 2.5) -> [DiscoveredServer] {
        let queue = DispatchQueue(label: "goondrop.discover", attributes: .concurrent)
        let semaphore = DispatchSemaphore(value: 0)
        let lock = NSLock()
        var broadcastResults: [DiscoveredServer] = []
        var scanResults: [DiscoveredServer] = []

        queue.async {
            broadcastResults = broadcastDiscover(timeout: timeout)
            semaphore.signal()
        }
        queue.async {
            scanResults = httpSubnetScan()
            semaphore.signal()
        }

        semaphore.wait()
        semaphore.wait()

        lock.lock()
        defer { lock.unlock() }
        var seen = Set<String>()
        var merged: [DiscoveredServer] = []
        for server in broadcastResults + scanResults {
            if seen.insert(server.id).inserted {
                merged.append(server)
            }
        }
        return merged
    }

    // MARK: - UDP broadcast discovery (existing path)

    /// Broadcast `goondrop_discover` on UDP 3943 and collect every server that replies.
    private static func broadcastDiscover(timeout: TimeInterval = 2.5) -> [DiscoveredServer] {
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

    // MARK: - Unicast HTTP subnet scan (fallback for broadcast-hostile networks)

    /// Sweep the current /24 subnet (excluding our own IP) probing each host's
    /// `GET /api/qrcode` on port 3941. Any host answering 200 + a pairing code is a
    /// Goon Drop PC. Returns once found, capped at a few seconds.
    private static func httpSubnetScan() -> [DiscoveredServer] {
        guard let base = subnetBase() else { return [] }

        let queue = DispatchQueue(label: "goondrop.subnetscan", attributes: .concurrent)
        let gate = DispatchSemaphore(value: 32)
        let lock = NSLock()
        let group = DispatchGroup()
        var found: [DiscoveredServer] = []

        var hosts: [String] = []
        for i in 1...254 {
            let ip = "\(base).\(i)"
            if ip == myIPv4() { continue }
            hosts.append(ip)
        }

        for host in hosts {
            gate.wait()
            group.enter()
            queue.async {
                defer { gate.signal(); group.leave() }
                guard let server = httpProbe(ip: host) else { return }
                lock.lock()
                if !found.contains(where: { $0.ip == server.ip }) {
                    found.append(server)
                }
                lock.unlock()
            }
        }

        _ = group.wait(timeout: .now() + 10)
        return found
    }

    /// Probe one host on the Goon Drop query endpoint. Synchronous, bounded time.
    private static func httpProbe(ip: String) -> DiscoveredServer? {
        func makeRequest() -> URLRequest? {
            guard let url = URL(string: "http://\(ip):3941/api/qrcode") else { return nil }
            var request = URLRequest(url: url)
            request.httpMethod = "GET"
            request.timeoutInterval = 0.7
            return request
        }
        guard let request = makeRequest() else { return nil }
        let config = URLSessionConfiguration.ephemeral
        config.timeoutIntervalForRequest = 0.7
        config.timeoutIntervalForResource = 0.9
        config.waitsForConnectivity = false
        config.requestCachePolicy = .reloadIgnoringLocalCacheData
        let session = URLSession(configuration: config)
        let semaphore = DispatchSemaphore(value: 0)
        var result: DiscoveredServer?

        let task = session.dataTask(with: request) { data, response, _ in
            defer { semaphore.signal() }
            guard let http = response as? HTTPURLResponse, http.statusCode == 200,
                  let data = data,
                  let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
                  let code = obj["pairingCode"] as? String, !code.isEmpty
            else { return }
            result = DiscoveredServer(
                ip: ip,
                port: 3942,
                pairingCode: code,
                serverName: obj["serverName"] as? String ?? "Goon Drop"
            )
        }
        task.resume()
        _ = semaphore.wait(timeout: .now() + 1.0)
        session.invalidateAndCancel()
        return result
    }

    // MARK: - Local network helpers

    /// The IP prefix (first three octets) of the Wi-Fi interface we're on, or nil.
    private static func subnetBase() -> String? {
        guard let ipString = myIPv4() else { return nil }
        let parts = ipString.split(separator: ".")
        guard parts.count == 4 else { return nil }
        return "\(parts[0]).\(parts[1]).\(parts[2])"
    }

    /// Our own non-loopback IPv4, preferring the Wi-Fi interface (en0).
    private static func myIPv4() -> String? {
        var ifaddrPtr: UnsafeMutablePointer<ifaddrs>?
        guard getifaddrs(&ifaddrPtr) == 0, let first = ifaddrPtr else { return nil }
        defer { freeifaddrs(ifaddrPtr) }

        var fallback: String?
        var best: String?

        for ptr in sequence(first: first, next: { $0.pointee.ifa_next }) {
            let ifa = ptr.pointee
            guard let sa = ifa.ifa_addr, sa.pointee.sa_family == UInt8(AF_INET) else { continue }
            let name = String(cString: ifa.ifa_name)
            if name == "lo0" || name.hasPrefix("utun") || name.hasPrefix("ap1") { continue }

            var host = [CChar](repeating: 0, count: Int(NI_MAXHOST))
            let sin = withUnsafePointer(to: &sa.pointee) { $0.withMemoryRebound(to: sockaddr.self, capacity: 1) { addr in
                getnameinfo(addr, socklen_t(sa.pointee.sa_len), &host, socklen_t(host.count), nil, 0, NI_NUMERICHOST)
            } }
            if sin == 0 {
                let ip = String(cString: host)
                if name == "en0" {
                    best = ip
                    break
                } else if fallback == nil {
                    fallback = ip
                }
            }
        }
        return best ?? fallback
    }
}