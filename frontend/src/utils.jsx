import React, {useLayoutEffect, useState, } from "react";
// import {Navigate, useNavigate} from "react-router-dom";
import {debounce, differenceWith, intersectionWith, isEqual, reduce, unionWith, memoize} from "lodash";
import Papa from "papaparse";
import {saveAs} from 'file-saver';
// import {useDataGetter} from "../state/DataGetter";

export const NO_BREAK_SPACE = '\u00a0';
export const CHECKMARK = '\u2713';
export const RIGHT_ARROW = '\u2192';

// (Removed: dead N3C Enclave / Foundry @termhub/sdk auth code \u2014 EnclaveAuthTest,
// Logout, AuthCallback, client. The serverless demo has no enclave integration.
// Vite's dependency pre-scan flagged the commented @termhub/sdk import, so it's
// deleted rather than left commented.)

export const pct_fmt = (num) =>
  Number(num).toLocaleString(undefined, {
    style: "percent",
    minimumFractionDigits: 2,
  });
export const fmt = (num) => Number(num).toLocaleString();
// cfmt = conditional format -- as number if number, otherwise no change
export const cfmt = (v) =>
  parseInt(v) === v || parseFloat(v) === v ? Number(v).toLocaleString() : v;

// from https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Set#implementing_basic_set_operations
export function isSuperset(set, subset) {
  for (const elem of subset) {
    if (!set.has(elem)) {
      return false;
    }
  }
  return true;
}

export function union(setA, setB) {
  const _union = new Set(setA);
  for (const elem of setB) {
    _union.add(elem);
  }
  return _union;
}

export function intersection(setA, setB) {
  const _intersection = new Set();
  for (const elem of setB) {
    if (setA.has(elem)) {
      _intersection.add(elem);
    }
  }
  return _intersection;
}

export function symmetricDifference(setA, setB) {
  const _difference = new Set(setA);
  for (const elem of setB) {
    if (_difference.has(elem)) {
      _difference.delete(elem);
    } else {
      _difference.add(elem);
    }
  }
  return _difference;
}

export function difference(setA, setB) {
  const _difference = new Set(setA);
  for (const elem of setB) {
    _difference.delete(elem);
  }
  return _difference;
}
export function toRadians(angle) {
  return angle * (Math.PI / 180);
}

export function useWindowSize() {
  const [size, setSize] = useState([0, 0]);
  useLayoutEffect(() => {
    const updateSize = debounce(function () {
      setSize([window.innerWidth, window.innerHeight]);
    }, 300);
    window.addEventListener("resize", updateSize);
    updateSize();
    return () => window.removeEventListener("resize", updateSize);
  }, []);
  return size;
}

export function ShowWindowDimensions(props) {
  const [width, height] = useWindowSize();
  return (
    <span>
      Window size: {width} x {height}
    </span>
  );
}

export function oneSidedObjectDifference(a ,b) {
  // return all items in b that are different from a
  return reduce(b, function(acc, val, key, col) {
    if ( !isEqual(a[key], val )) {
        acc[key] = val;
    }
    return acc;
  }, {})
}

export function median(array) {
  array.sort();
  const mid = array.length / 2;
  if (array.length % 2 === 0) {
    return (array[mid] + array[mid - 1]) / 2;
  } else {
    return array[mid];
  }
}

export function mean(array) {
  let total = 0;
  for (let i = 0; i < array.length; i++) {
    total += array[i];
  }
  return total / array.length;
}

export function saveCsv(rows, columns, filename, config=null, tsv = false) {

  config = config || {
    delimiter: tsv ? "\t" : ",",
    newline: "\n",
    // defaults
    quotes: tsv ? false : (c => {
      c = c.toString();
      return c.includes(",") || c.includes("\n");
    }),
    error: (error, file) => {
      console.error(error);
      console.log(file);
    },
    // header: true,
    // skipEmptyLines: false, //other option is 'greedy', meaning skip delimiters, quotes, and whitespace.
    columns: columns, //or array of strings
  }
  const dataString = Papa.unparse(rows, config);
  if (!filename) {
    return dataString;
  }
  const blob = new Blob([dataString], {
    type: tsv ? 'text/tab-separated-values;charset=utf-8' : 'text/csv;charset=utf-8'
  });
  saveAs(blob, filename);
}

export function setOp(op, setA, setB, transform = d => d) {
  /*
   * Convenience function to perform set operations using == instead of ===
   *    mostly because concept_ids are sometimes strings, sometimes ints.
   *    It can go really slow. And -- weirdly, union with a large setA and empty
   *    setB can take a surprisingly long time.
   *
   * setOp(op, setA, setB)
   *   - op: one of union, difference, intersection
   *   - setA, setB: can be an array, Set, or Iterator (like you get from map.keys())
   *   - transform: function to map the results onto (e.g., parseInt, or d => d.toLocaleString())
   *   - returns: a new set of items based on ==, so integers are equivalent to their string representations
   */
  const f = ({
                      union: unionWith,
                      difference: differenceWith,
                      intersection: intersectionWith
  })[op];
  if (setA instanceof Set || setA instanceof Iterator) setA = [...setA];
  if (setB instanceof Set || setB instanceof Iterator) setB = [...setB];
  return f(setA, setB, (itemA, itemB) => itemA == itemB).map(transform);
}

export function isJsonString(str) {
  if (typeof str !== "string") {
    return false;
  }
  try {
    const parsed = JSON.parse(str);
    return (parsed && typeof parsed === "object") ? true : false;
  } catch (e) {
    return false;
  }
}

/*
export function useComparePrevProps = (props) => {
  const prevProps = usePrevious(props);
  return prevProps!== props;
}
*/