// @ts-nocheck
export async function generateStaticParams() {
  return [{
    category: "books"
  }, {
    category: "maps"
  }];
}

/**
 * @param {{ children: unknown }} props
 */
export default async function LibraryCategoryLayout(props) {
  const {
    children
  } = props;
  return children;
}