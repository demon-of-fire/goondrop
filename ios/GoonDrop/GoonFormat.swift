import Foundation

/// Small shared formatting helpers used across the native UI.
enum GoonFormat {

    /// Milliseconds → readable relative time ("just now", "5m ago", "3h ago"...).
    static func relative(_ milliseconds: Int) -> String {
        let date = Date(timeIntervalSince1970: Double(milliseconds) / 1000.0)
        let formatter = RelativeDateTimeFormatter()
        formatter.unitsStyle = .short
        return formatter.localizedString(for: date, relativeTo: Date())
    }

    /// Milliseconds → short date/time like "16 Sep 14:32".
    static func short(_ milliseconds: Int) -> String {
        let date = Date(timeIntervalSince1970: Double(milliseconds) / 1000.0)
        let formatter = DateFormatter()
        formatter.dateFormat = "d MMM HH:mm"
        return formatter.string(from: date)
    }
}