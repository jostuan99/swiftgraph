#if os(iOS)
import UIKit

/// Formats a title for the current platform.
public func formatTitle(_ title: String) -> String {
    title.uppercased()
}
#else
public func formatTitle(_ title: String) -> String {
    title
}
#endif
