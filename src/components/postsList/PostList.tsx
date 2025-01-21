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
    <div className="mt-[32px]">
      {posts.map((page) => {
        return (
          <a
            hrefLang={locale}
            href={getRelativeLocaleUrl(locale, `/posts/${page.slug}`)}
          >
            <div className="mb-[42px]">
              <div className="text-fg-400 font-extrabold text-3xl mb-1">
                {page.title}
              </div>
              <div className="text-fg-200 text-sm mb-[6px]">{page.date}</div>
              <div className="italic text-sm"># {page.tagDisplayName}</div>
            </div>
          </a>
        );
      })}
    </div>
  );
};

export default PostList;
