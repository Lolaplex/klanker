import React, { useEffect, useState } from "react";
import { Star } from "lucide-react";
import { ModelProvider } from "../openrouterModels";

interface ModelControlProps {
  provider: ModelProvider;
  label: string;
  model: string;
  recent: string[];
  favorites: string[];
  ranked: string[];
  loading: boolean;
  note: string | null;
  onDraft: (id: string) => void;
  onCommit: (id: string) => void;
  onToggleStar: (id: string) => void;
}

const inputClass =
  "min-w-0 flex-1 bg-[#121212] border border-[#262626] focus:border-white rounded px-2.5 py-1.5 text-white outline-none";

function visibleIds(ids: string[], typed: string, browsing: boolean): string[] {
  if (browsing) return ids;
  const query = typed.toLowerCase();
  return ids.filter((id) => id.toLowerCase().includes(query));
}

export const ModelControl: React.FC<ModelControlProps> = ({
  provider,
  label,
  model,
  recent,
  favorites,
  ranked,
  loading,
  note,
  onDraft,
  onCommit,
  onToggleStar,
}) => {
  const [text, setText] = useState(model);

  useEffect(() => {
    setText(model);
  }, [model, provider]);

  const typed = text.trim();
  const browsing = typed === "" || typed === model.trim();
  const recentIds = visibleIds(recent, typed, browsing);
  const favoriteIds = visibleIds(favorites, typed, browsing);
  const rankedIds = visibleIds(
    ranked.filter((id) => !recent.includes(id) && !favorites.includes(id)),
    typed,
    browsing
  );
  const starred = (id: string) => favorites.includes(id);
  const showList = recentIds.length + favoriteIds.length + rankedIds.length > 0;

  const commit = () => {
    if (typed === model.trim()) return;
    onCommit(typed);
  };

  return (
    <div>
      <label className="text-[10px] text-[#737373] uppercase tracking-wider block mb-1">{label}</label>
      <div className="flex items-center gap-1">
        <input
          type="text"
          value={text}
          spellCheck={false}
          placeholder="model id"
          onChange={(event) => {
            setText(event.target.value);
            onDraft(event.target.value);
          }}
          onBlur={commit}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.preventDefault();
              event.currentTarget.blur();
            }
          }}
          className={inputClass}
        />
        <button
          type="button"
          title="Favorite this model"
          disabled={!typed}
          onMouseDown={(event) => event.preventDefault()}
          onClick={() => onToggleStar(typed)}
          className="p-1.5 bg-[#0a0a0a] hover:bg-[#141414] border border-[#262626] rounded text-[#a3a3a3] hover:text-white disabled:opacity-40"
        >
          <Star className={`w-3.5 h-3.5 ${starred(typed) ? "fill-white text-white" : ""}`} />
        </button>
      </div>
      {showList && (
        <div className="mt-1 max-h-36 overflow-y-auto border border-[#262626] rounded">
          <ModelRows title="Recent" ids={recentIds} current={typed} favorites={favorites} onCommit={onCommit} onToggleStar={onToggleStar} />
          <ModelRows title="Favorites" ids={favoriteIds} current={typed} favorites={favorites} onCommit={onCommit} onToggleStar={onToggleStar} />
          <ModelRows title="Top" ids={rankedIds} current={typed} favorites={favorites} onCommit={onCommit} onToggleStar={onToggleStar} />
        </div>
      )}
      {loading && !showList && <p className="mt-1 text-[10px] text-[#737373]">Loading OpenRouter models...</p>}
      {note && <p className="mt-1 text-[10px] text-[#a3a3a3]">{note}</p>}
    </div>
  );
};

function ModelRows({
  title,
  ids,
  current,
  favorites,
  onCommit,
  onToggleStar,
}: {
  title: string;
  ids: string[];
  current: string;
  favorites: string[];
  onCommit: (id: string) => void;
  onToggleStar: (id: string) => void;
}) {
  if (ids.length === 0) return null;
  return (
    <div>
      <div className="px-2 pt-1 text-[10px] uppercase tracking-wider text-[#737373]">{title}</div>
      {ids.map((id) => {
        const on = favorites.includes(id);
        const selected = id === current;
        return (
          <div key={`${title}:${id}`} className={`flex items-center ${selected ? "bg-[#141414]" : "hover:bg-[#181818]"}`}>
            <button
              type="button"
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => onCommit(id)}
              className={`min-w-0 flex-1 truncate px-2 py-1 text-left ${selected ? "text-white" : "text-[#a3a3a3] hover:text-white"}`}
            >
              {id}
            </button>
            <button
              type="button"
              title={on ? "Unfavorite" : "Favorite"}
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => onToggleStar(id)}
              className="p-1 text-[#a3a3a3] hover:text-white"
            >
              <Star className={`w-3 h-3 ${on ? "fill-white text-white" : ""}`} />
            </button>
          </div>
        );
      })}
    </div>
  );
}
