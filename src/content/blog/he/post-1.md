---
title: שלום עולם
date: "2025-01-09"
tag: { displayName: "קפה", uriName: "cofee" }
description: "שלום עולם זה התיאור של הפוסט."
---

# כותרת H1

זה פוסט שמכיל הרבה סינטקס מרקדוון. המטרה שלו היא לראות איך הבלוג נראה בעברית. אני בכוונה כותב פה הרבה טקסט בלי לרדת שורה כי אני רוצה לראות איך זה נראה בתיאור של הפוסט בעמוד הראשי.

## כותרת H2

### כותרת H3

#### כותרת H4

##### כותרת H5

###### כותרת H6

בנוסף, אפשר לעשות ל H1 ו H2 איטליאן

# אלטרנטיבי H1

## אלטרנטיבי H2

---

# הבלטה

הבלטה, כלומר איטלי, עם _מקף תחתון_.

הבלטה חזקה, כלומר הדגשה, עם **כוכביות**.

הדגשה משולבת עם **כוכביות וגם _מקפים_**

קו באמצע עם שתי טילדות. ~~תמחק את זה~~

---

# רשימות

1. פריט ראשוני ברשימה
2. עוד פריט
   - תת רשימה לא סדורה.
3. המספר לא משנה, רק שזה מספר
   1. תת רשימה סדורה
4. ועוד פריט

5. לעשות שינויים
   1. לתקן באג
   2. לשפר פורמטינג
      - לעשות כותרות גדולות יותר
6. לדחוף את כל הקומיטס לגיטהאב
7. לפתוח פול ריקווסט
   - לתאר את השינויים
   - לטייג את כל חברי הצוות
     - לבקש פידבק

---

# רשימת משימות

- [x] לסיים משימה
- [ ] להכין פול ריקווסט
- [ ] לסמן טיקט כסגור

---

# קישורים

[אני לינק](https://www.google.com)

[אני לינק עם כותרת](https://www.google.com "Google's Homepage")

[אני לינק רלטיבי](../blob/master/LICENSE)

[אפשר להשתמש במספרים בשביל לינקים סגנון רפרנס][1]

או להשאיר את זה ריק ולהשתמש בלינק עצמו [טקסט לינק עצמו].

קישורים בסוגריים משולשים הופכים אוטומטית ללינקים.
לדוגמא http://www.example.com או <http://www.example.com> ולפעמים גם
example.com

קישורי רפרנס יכולים להגיע אחר כך:

[טקסט ארביטררי]: https://www.mozilla.org
[1]: http://slashdot.org
[טקסט לינק עצמו]: http://www.reddit.com

---

# תמונות

לוגו:

![תיאור טקטסט](https://github.com/adam-p/markdown-here/raw/master/src/common/images/icon48.png "טקסט לוגו 1")

סגנון רפרנס:

![רפרס][logo]

[logo]: https://github.com/adam-p/markdown-here/raw/master/src/common/images/icon48.png "טקסט לוגו 2"

![מיניון](https://octodex.github.com/images/minion.png)
![חייל](https://octodex.github.com/images/stormtroopocat.jpg "סטורפ טרופר")

לינקים עם סגנון של הערות:

![טקסט][id]

עם רפרנס מאוחר יותר במסמך שמגדיר את הקישורים

[id]: https://octodex.github.com/images/dojocat.jpg "טקסט"

---

# [הערות סוף מסמך](https://github.com/markdown-it/markdown-it-footnote)

קישור סוף מסמך[^first].

קישור סוף מסמך אינליין^[Text of inline footnote] definition.

רפרנס כפולה של הערות סוף מסמך[^second].

[^first]: הערה **יכולה להיות עם עיצוב**

    וכמה פסקאות.

[^second]: הערה טקסט.

---

# Code and Syntax Highlighting

```
Inline `code` has `back-ticks around` it.
```

אינליין `code` יש לו `back-ticks around` מסביבו.

```c#
using System.IO.Compression;

#pragma warning disable 414, 3021

namespace MyApplication
{
    [Obsolete("...")]
    class Program : IInterface
    {
        public static List<int> JustDoIt(int count)
        {
            Console.WriteLine($"Hello {Name}!");
            return new List<int>(new int[] { 1, 2, 3 })
        }
    }
}
```

```css
@font-face {
  font-family: Chunkfive;
  src: url("Chunkfive.otf");
}

body,
.usertext {
  color: #f0f0f0;
  background: #600;
  font-family: Chunkfive, sans;
}

@import url(print.css);
@media print {
  a[href^="http"]::after {
    content: attr(href);
  }
}
```

```javascript
function $initHighlight(block, cls) {
  try {
    if (cls.search(/\bno\-highlight\b/) != -1)
      return process(block, true, 0x0F) +
             ` class="${cls}"`;
  } catch (e) {
    /* handle exception */
  }
  for (var i = 0 / 2; i < classes.length; i++) {
    if (checkCondition(classes[i]) === undefined)
      console.log('undefined');
  }
}

export  $initHighlight;
```

```php
require_once 'Zend/Uri/Http.php';

namespace Location\Web;

interface Factory
{
    static function _factory();
}

abstract class URI extends BaseURI implements Factory
{
    abstract function test();

    public static $st1 = 1;
    const ME = "Yo";
    var $list = NULL;
    private $var;

    /**
     * Returns a URI
     *
     * @return URI
     */
    static public function _factory($stats = array(), $uri = 'http')
    {
        echo __METHOD__;
        $uri = explode(':', $uri, 0b10);
        $schemeSpecific = isset($uri[1]) ? $uri[1] : '';
        $desc = 'Multi
line description';

        // Security check
        if (!ctype_alnum($scheme)) {
            throw new Zend_Uri_Exception('Illegal scheme');
        }

        $this->var = 0 - self::$st;
        $this->list = list(Array("1"=> 2, 2=>self::ME, 3 => \Location\Web\URI::class));

        return [
            'uri'   => $uri,
            'value' => null,
        ];
    }
}

echo URI::ME . URI::$st1;

__halt_compiler () ; datahere
datahere
datahere */
datahere
```

---

# טבלאות

| טבלאות      |      הן      |  מגניבות |
| ----------- | :----------: | -------: |
| עמודה 3 היא | מוצמדת לימין | 1600 שקל |
| עמודה 2 היא |     אמצע     |   12 שקל |
| פסי זברה    |   זה נחמד    |    1 שקל |

---

# ציטוטים

> ציטוטים הם מאוד שימושיים כדי לחקות תשובה של אימייל
> השורה הזאת היא חלק מאותו ציטוט

> זו שורה ארוכה מאוד מאוד. בואו נמשיך לתכוב כדי שהיא תהיה במיוחד ארוכה מאוד. בנוסף לא לשכוח שיכול לבוא **הדגשה** באמצע המסמך

> ציטוטים יכולים להיות מוטמעים אחד בשני
>
> > על ידי שימוש בסימן גדול מ נוסף
> >
> > > או עם רווחים בין החצים

---

# סרטוני יוטיוב

<a href="http://www.youtube.com/watch?feature=player_embedded&v=YOUTUBE_VIDEO_ID_HERE" target="_blank">
<img src="http://img.youtube.com/vi/YOUTUBE_VIDEO_ID_HERE/0.jpg" alt="IMAGE ALT TEXT HERE" width="240" height="180" border="10">
</a>

[![טקסט תמונה](https://upload.wikimedia.org/wikipedia/commons/thumb/e/ef/YouTube_logo_2015.svg/1200px-YouTube_logo_2015.svg.png)](https://www.youtube.com/watch?v=ciawICBvQoE)
