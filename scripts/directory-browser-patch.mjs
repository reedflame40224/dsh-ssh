import ts from 'typescript';

export function addDirectoryActions(source) {
  const ast = ts.createSourceFile('client.js', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  const matches = [];
  function visit(node) {
    if (ts.isFunctionDeclaration(node) && node.name?.text === 'DirectoryBrowser') matches.push(node);
    ts.forEachChild(node, visit);
  }
  visit(ast);
  if (matches.length !== 1) throw new Error('Expected one DirectoryBrowser function');
  const binding = matches[0].parameters[0]?.name;
  if (!binding || !ts.isObjectBindingPattern(binding)) throw new Error('Unsupported DirectoryBrowser parameter');
  const names = new Set(binding.elements.map(element => element.propertyName?.getText(ast) ?? element.name.getText(ast)));
  for (const name of ['open', 'listDirectory', 'createDirectory', 'onOpen', 'onClose', 'busy', 't']) {
    if (!names.has(name)) throw new Error(`DirectoryBrowser is missing required parameter: ${name}`);
  }
  if (names.has('renderActions') || binding.elements.some(element => element.dotDotDotToken)) throw new Error('DirectoryBrowser already extended or contains rest parameters');
  const last = binding.elements.at(-1);
  const trailing = binding.elements.hasTrailingComma;
  const insertion = trailing ? ' renderActions,' : ', renderActions';
  const at = trailing ? binding.end - 1 : last.end;
  return source.slice(0, at) + insertion + source.slice(at);
}
