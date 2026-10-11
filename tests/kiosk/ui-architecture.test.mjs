import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import ts from 'typescript';
const root = new URL('../../apps/kiosk/src/', import.meta.url);
const components = new URL('components/', root);
const forbidden = new Set([
  'style',
  'className',
  'textStyle',
  'containerStyle',
  'contentContainerStyle',
  'background',
  'backgroundColor',
  'border',
  'borderRadius',
  'color',
  'fontSize',
  'fontFamily',
  'shadow',
  'css',
  'sx',
]);
const layoutProps = new Set([
  'padding',
  'paddingX',
  'paddingY',
  'margin',
  'gap',
  'flex',
  'width',
  'maxWidth',
  'alignSelf',
]);
const parse = (name, text) =>
  ts.createSourceFile(name, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
function walk(node, visit) {
  visit(node);
  ts.forEachChild(node, (child) => walk(child, visit));
}
const files = readdirSync(components).filter(
  (n) => n.endsWith('.tsx') && !n.endsWith('.stories.tsx'),
);
test('all first-party component APIs reject cosmetic overrides and keep layout in Wrapper', () => {
  for (const name of files) {
    const source = parse(name, readFileSync(new URL(name, components), 'utf8'));
    const localImports = new Set();
    for (const node of source.statements)
      if (ts.isImportDeclaration(node) && node.moduleSpecifier.text.startsWith('.')) {
        const bindings = node.importClause?.namedBindings;
        if (bindings && ts.isNamedImports(bindings))
          for (const item of bindings.elements) localImports.add(item.name.text);
      }
    walk(source, (node) => {
      if (ts.isPropertySignature(node)) {
        const key = node.name.getText(source).replace(/['"]/g, '');
        assert(!forbidden.has(key), `${name}: forbidden public prop ${key}`);
        assert(
          name === 'Wrapper.tsx' || !layoutProps.has(key),
          `${name}: layout prop ${key} belongs to Wrapper`,
        );
      }
      if (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) {
        if (localImports.has(node.tagName.getText(source)))
          for (const prop of node.attributes.properties) {
            if (ts.isJsxAttribute(prop))
              assert(
                !forbidden.has(prop.name.getText(source)),
                `${name}: appearance passed to ${node.tagName.getText(source)}`,
              );
          }
      }
    });
  }
});
test('screens and entrypoints only compose components and contain no local visual helpers', () => {
  const paths = [
    ...readdirSync(new URL('screens/', root))
      .filter((n) => n.endsWith('.tsx'))
      .map((n) => 'screens/' + n),
    'KioskApp.tsx',
    '../App.tsx',
  ];
  for (const path of paths) {
    const source = parse(path, readFileSync(new URL(path, root), 'utf8'));
    walk(source, (node) => {
      if (ts.isJsxAttribute(node))
        assert(!forbidden.has(node.name.getText(source)), `${path}: inline appearance override`);
      if (ts.isImportDeclaration(node))
        assert(
          !['react-native', 'expo-image', 'expo-linear-gradient'].includes(
            node.moduleSpecifier.text,
          ),
          `${path}: raw visual primitives belong to components`,
        );
      if (ts.isFunctionDeclaration(node) && node.name && /^[A-Z]/.test(node.name.text))
        assert(
          /Screen$|^KioskApp$|^App$/.test(node.name.text),
          `${path}: local component ${node.name.text}`,
        );
    });
  }
});
test('every exported visual component has its own Storybook entry', () => {
  for (const name of files) {
    const source = parse(name, readFileSync(new URL(name, components), 'utf8'));
    for (const node of source.statements) {
      if (
        !ts.isFunctionDeclaration(node) ||
        !node.name ||
        !node.modifiers?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword)
      )
        continue;
      const story = new URL(node.name.text + '.stories.tsx', components);
      const text = readFileSync(story, 'utf8');
      assert.match(
        text,
        new RegExp('component:\\s*' + node.name.text + '\\b'),
        `${name}: story must render the real component`,
      );
    }
  }
});
test('Wrapper cannot change child appearance or expose an untyped escape hatch', () => {
  const source = readFileSync(new URL('Wrapper.tsx', components), 'utf8');
  assert.doesNotMatch(
    source,
    /cloneElement|\.\.\.rest|\[key:\s*string\]|background|border|shadow|opacity|transform|fontFamily/,
  );
  const preview = readFileSync(new URL('../.storybook/preview.css', root), 'utf8');
  assert.doesNotMatch(
    preview,
    /color|background|border|outline|shadow|font|opacity/,
    'Storybook must not supply component appearance through global CSS',
  );
});
test('every kiosk text ignores iPad system text size (Dynamic Type) through fixedText', () => {
  // React 19 has no defaultProps for function components, so each Text, Animated.Text and
  // TextInput spreads `fixedText` itself; a grown system size would overflow fixed layouts.
  const paths = [
    ...files.map((n) => 'components/' + n),
    ...readdirSync(new URL('screens/', root))
      .filter((n) => n.endsWith('.tsx'))
      .map((n) => 'screens/' + n),
  ];
  let checked = 0;
  for (const path of paths) {
    const source = parse(path, readFileSync(new URL(path, root), 'utf8'));
    walk(source, (node) => {
      if (!ts.isJsxOpeningElement(node) && !ts.isJsxSelfClosingElement(node)) return;
      const tag = node.tagName.getText(source);
      if (!['Text', 'Animated.Text', 'TextInput'].includes(tag)) return;
      checked++;
      assert(
        node.attributes.properties.some(
          (p) => ts.isJsxSpreadAttribute(p) && p.expression.getText(source) === 'fixedText',
        ),
        `${path}: <${tag}> without {...fixedText}`,
      );
    });
  }
  assert(checked > 100, 'the check must see the kiosk texts');
});
