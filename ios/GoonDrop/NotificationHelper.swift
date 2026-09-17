import Foundation
import UserNotifications

/// Requests notification permission once so the Share Sheet extension can post
/// its "Sent to <PC>" completion banners.
enum NotificationHelper {
    private static let askedKey = "goondrop_notifications_requested"

    static func requestAuthorizationIfNeeded() {
        let defaults = UserDefaults(suiteName: SharedConfig.appGroupName) ?? .standard
        guard !defaults.bool(forKey: askedKey) else { return }
        defaults.set(true, forKey: askedKey)
        UNUserNotificationCenter.current().requestAuthorization(options: [.alert, .sound]) { _, _ in }
    }
}
