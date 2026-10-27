public protocol Logging {
    func log(_ message: String)
}

extension Logging {
    public func log(_ message: String) {
        print(message)
    }
}

public class ConsoleLogger: Logging {
    public init() {}

    public func log(_ message: String) {
        print("[console] " + message)
    }
}

public final class PrefixLogger: ConsoleLogger {
    let prefix: String

    public init(prefix: String) {
        self.prefix = prefix
        super.init()
    }

    public override func log(_ message: String) {
        super.log(prefix + message)
    }
}
