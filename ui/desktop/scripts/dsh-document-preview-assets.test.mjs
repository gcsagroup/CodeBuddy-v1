import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { installDocumentRuntimeCompatibility } from './dsh-document-compat.mjs';
import { dshDocumentPreviewAssets } from './dsh-document-preview-assets.mjs';

test('PDF compatibility preserves precision, overflow, signed zero and iterator errors', () => {
  const context = vm.createContext({});
  vm.runInContext('delete Math.sumPrecise', context);
  vm.runInContext(`(${installDocumentRuntimeCompatibility.toString()})();`, context);
  const sum = vm.runInContext('Math.sumPrecise', context);
  assert.equal(sum([1e20, 0.1, -1e20]), 0.1);
  assert.equal(sum([Number.MAX_VALUE, Number.MAX_VALUE, -Number.MAX_VALUE]), Number.MAX_VALUE);
  assert.equal(sum([-Number.MAX_VALUE, -Number.MAX_VALUE, Number.MAX_VALUE]), -Number.MAX_VALUE);
  assert.equal(sum([Number.MAX_VALUE, Number.MAX_VALUE]), Infinity);
  assert.equal(sum([Number.MIN_VALUE, Number.MIN_VALUE]), Number.MIN_VALUE * 2);
  assert.equal(sum([Infinity, -Infinity]), NaN);
  assert.ok(Object.is(sum([]), -0));
  assert.ok(Object.is(sum([-0, -0]), -0));
  assert.ok(Object.is(sum([-1, 1]), 0));
  let closed = false;
  function* invalid() {
    try {
      yield NaN;
      yield '3';
    } finally {
      closed = true;
    }
  }
  assert.throws(() => sum(invalid()), /not a number/);
  assert.ok(closed);
  vm.runInContext(`(${installDocumentRuntimeCompatibility.toString()})();`, context);
  assert.equal(vm.runInContext('Math.sumPrecise', context), sum);
});

test('pinned PDF chunk installs compatibility before both renderer and worker execute', () => {
  const plugin = dshDocumentPreviewAssets();
  const source = plugin.load.call({ addWatchFile() {} }, '\0virtual:codebuddy-dsh-document/pdf');
  assert.ok(source.startsWith('/*'));
  assert.match(source, /Permission is hereby granted/);
  assert.match(source, /var _dsh_pdf_worker_default = "\/\*/);
  assert.equal(source.split('function installDocumentRuntimeCompatibility()').length, 3);
  assert.match(source, /export default \(\{/);
  assert.match(source, /exports.PdfBody = PdfBody/);
});
