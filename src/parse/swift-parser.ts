// Tree-sitter parser for Swift, from the tree-sitter-swift grammar package.

import Parser from 'tree-sitter';
import Swift from 'tree-sitter-swift';

export type SyntaxNode = Parser.SyntaxNode;
export type Tree = Parser.Tree;

// The default input buffer of node-tree-sitter is small; large files are read
// in fewer callbacks with a bigger buffer.
const BUFFER_SIZE = 1 << 20;

let sharedParser: Parser | undefined;

export function swiftParser(): Parser {
  if (!sharedParser) {
    sharedParser = new Parser();
    sharedParser.setLanguage(Swift as Parser.Language);
  }
  return sharedParser;
}

export function parseSwift(source: string): Tree {
  return swiftParser().parse(source, undefined, { bufferSize: BUFFER_SIZE });
}
