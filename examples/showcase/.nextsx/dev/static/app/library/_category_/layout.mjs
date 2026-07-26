// @ts-nocheck
async function generateStaticParams() {
  return [{
    category: "books"
  }, {
    category: "maps"
  }];
}

/**
 * @param {{ children: unknown }} props
 */
async function LibraryCategoryLayout(props) {
  const {
    children
  } = props;
  return children;
}

export { LibraryCategoryLayout as default, generateStaticParams };
//# sourceMappingURL=layout.mjs.map
