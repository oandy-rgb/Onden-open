import { Rss } from "lucide-react";

// Settings › 功能 › 閱讀: two article rows as the reader draws them, without
// words (the lines stand for a title and its first sentence).
export default function ReadingPreview() {
  return (
    <div className="feature-preview feature-preview--articles" aria-hidden="true">
      {[0, 1].map((i) => (
        <div key={i} className="feature-preview-article">
          <Rss size={14} />
          <span className="feature-preview-lines"><i /><i /></span>
        </div>
      ))}
    </div>
  );
}
