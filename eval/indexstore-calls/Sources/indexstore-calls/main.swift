// Prints the calls recorded by the compiler's index store, as ground truth for
// the swiftgraph resolver (docs/graph/02-plan.md, G2).
//
// Output, one line per call site whose caller and callee are both defined
// under the repository root:
//
//     <caller file>\t<caller line>\t<callee file>\t<callee line>\t<callee name>\t<call file>\t<call line>
//
// Lines are those of the symbol names in their definitions. Paths are relative
// to the repository root.
//
// Usage: indexstore-calls <index store path> <libIndexStore.dylib> <repository root>

import Foundation
import IndexStoreDB

let arguments = CommandLine.arguments
guard arguments.count == 4 else {
    FileHandle.standardError.write("usage: indexstore-calls <store> <libIndexStore> <root>\n".data(using: .utf8)!)
    exit(2)
}
let storePath = arguments[1]
let libraryPath = arguments[2]
let root = URL(fileURLWithPath: arguments[3]).standardizedFileURL.resolvingSymlinksInPath().path + "/"

let databasePath = NSTemporaryDirectory() + "indexstore-calls-\(ProcessInfo.processInfo.processIdentifier)"
defer { try? FileManager.default.removeItem(atPath: databasePath) }

let library = try IndexStoreLibrary(dylibPath: libraryPath)
let index = try IndexStoreDB(
    storePath: storePath,
    databasePath: databasePath,
    library: library,
    waitUntilDoneInitializing: true,
    listenToUnitEvents: false
)
index.pollForUnitChangesAndWait()

func relative(_ path: String) -> String? {
    let resolved = URL(fileURLWithPath: path).standardizedFileURL.resolvingSymlinksInPath().path
    return resolved.hasPrefix(root) ? String(resolved.dropFirst(root.count)) : nil
}

var definitions: [String: SymbolOccurrence?] = [:]
func definition(of usr: String) -> SymbolOccurrence? {
    if let cached = definitions[usr] { return cached }
    let found = index.occurrences(ofUSR: usr, roles: [.definition]).first
    definitions[usr] = found
    return found
}

var printed = Set<String>()
let callableKinds: Set<IndexSymbolKind> = [.function, .instanceMethod, .classMethod, .staticMethod, .constructor]

for name in index.allSymbolNames() {
    for occurrence in index.canonicalOccurrences(ofName: name) where callableKinds.contains(occurrence.symbol.kind) {
        guard occurrence.roles.contains(.definition),
              let calleeFile = relative(occurrence.location.path) else { continue }
        for call in index.occurrences(ofUSR: occurrence.symbol.usr, roles: [.call]) {
            guard let callFile = relative(call.location.path) else { continue }
            for relation in call.relations where relation.roles.contains(.calledBy) || relation.roles.contains(.containedBy) {
                guard let callerDefinition = definition(of: relation.symbol.usr),
                      let callerFile = relative(callerDefinition.location.path) else { continue }
                let line = [
                    callerFile, String(callerDefinition.location.line),
                    calleeFile, String(occurrence.location.line), occurrence.symbol.name,
                    callFile, String(call.location.line),
                ].joined(separator: "\t")
                if printed.insert(line).inserted { print(line) }
                break
            }
        }
    }
}
