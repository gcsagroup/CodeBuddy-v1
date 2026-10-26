/*
 * Math.sumPrecise implementation adapted from core-js (MIT),
 * https://github.com/zloirock/core-js/blob/master/packages/core-js/modules/es.math.sum-precise.js
 * Copyright (c) 2014-2026 Denis Pushkarev
 *
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:
 * The above copyright notice and this permission notice shall be included in
 * all copies or substantial portions of the Software.
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
 * SOFTWARE.
 */

// Electron 41 predates this API. PDF.js uses it while rewriting embedded fonts;
// an ordinary reduce loses precision and causes incorrect font fallbacks.
// This self-contained installer runs in both the renderer and PDF worker.
export function installDocumentRuntimeCompatibility() {
  if (typeof Math.sumPrecise === 'function') return;
  Object.defineProperty(Math, 'sumPrecise', {
    configurable: true,
    writable: true,
    value: function sumPrecise(items) {
      const numbers = [];
      let count = 0;
      let state = 'minus-zero';
      for (const value of items) {
        if (++count > Number.MAX_SAFE_INTEGER) throw new RangeError('Too many summands');
        if (typeof value !== 'number') throw new TypeError('Value is not a number');
        if (state === 'nan') continue;
        if (Number.isNaN(value)) state = 'nan';
        else if (value === Infinity) state = state === 'negative' ? 'nan' : 'positive';
        else if (value === -Infinity) state = state === 'positive' ? 'nan' : 'negative';
        else if (
          (value !== 0 || 1 / value === Infinity) &&
          (state === 'minus-zero' || state === 'finite')
        ) {
          state = 'finite';
          numbers.push(value);
        }
      }
      if (state === 'nan') return NaN;
      if (state === 'positive') return Infinity;
      if (state === 'negative') return -Infinity;
      if (state === 'minus-zero') return -0;

      const partials = [];
      const huge = 2 ** 1023;
      const ulp = 2 ** 971;
      const twoSum = (x, y) => {
        const hi = x + y;
        return { hi, lo: y - (hi - x) };
      };
      let overflow = 0;
      for (let x of numbers) {
        let used = 0;
        for (let y of partials) {
          if (Math.abs(x) < Math.abs(y)) [x, y] = [y, x];
          let sum = twoSum(x, y);
          if (Math.abs(sum.hi) === Infinity) {
            const sign = sum.hi === Infinity ? 1 : -1;
            overflow += sign;
            x = x - sign * huge - sign * huge;
            if (Math.abs(x) < Math.abs(y)) [x, y] = [y, x];
            sum = twoSum(x, y);
          }
          if (sum.lo !== 0) partials[used++] = sum.lo;
          x = sum.hi;
        }
        partials.length = used;
        if (x !== 0) partials.push(x);
      }
      let n = partials.length - 1;
      let hi = 0;
      let lo = 0;
      if (overflow !== 0) {
        const next = n >= 0 ? partials[n] : 0;
        n--;
        if (Math.abs(overflow) > 1 || (overflow > 0 && next > 0) || (overflow < 0 && next < 0))
          return overflow > 0 ? Infinity : -Infinity;
        const sum = twoSum(overflow * huge, next / 2);
        hi = sum.hi;
        lo = sum.lo * 2;
        if (Math.abs(2 * hi) === Infinity) {
          if (hi > 0)
            return hi === huge && lo === -ulp / 2 && n >= 0 && partials[n] < 0
              ? Number.MAX_VALUE
              : Infinity;
          return hi === -huge && lo === ulp / 2 && n >= 0 && partials[n] > 0
            ? -Number.MAX_VALUE
            : -Infinity;
        }
        if (lo !== 0) {
          partials[++n] = lo;
          lo = 0;
        }
        hi *= 2;
      }
      while (n >= 0) {
        const sum = twoSum(hi, partials[n--]);
        hi = sum.hi;
        lo = sum.lo;
        if (lo !== 0) break;
      }
      if (n >= 0 && ((lo < 0 && partials[n] < 0) || (lo > 0 && partials[n] > 0))) {
        const y = lo * 2;
        const x = hi + y;
        if (y === x - hi) hi = x;
      }
      return hi;
    },
  });
}
