import { getRelativeLocaleUrl } from "astro:i18n";
import type { Locale } from "../../i18n";

interface Props {
  posts: {
    title: string;
    date: string;
    slug: string;
    tagDisplayName: string;
  }[];
  locale: Locale;
}

const PostList = ({ posts, locale }: Props) => {
  return (
    <div className="mt-[48px]">
      {posts.map((page) => {
        return (
          <a
            hrefLang={locale}
            href={getRelativeLocaleUrl(locale, `/posts/${page.slug}`)}
          >
            <div className="mb-[42px]">
              <div className="text-fg-400 font-extrabold text-3xl mb-4">
                {page.title}
              </div>
              <div className="text-fg-200 mb-2">{page.date}</div>
              <div className="italic"># {page.tagDisplayName}</div>
            </div>
          </a>
        );
      })}
    </div>
  );
};

export default PostList;
