import Foundation

final class SettingsStore {
    private let defaults = UserDefaults.standard

    var lastUpdated: Date? {
        defaults.object(forKey: "lastUpdated") as? Date
    }

    func markUpdated(_ date: Date) {
        defaults.set(date, forKey: "lastUpdated")
    }
}
