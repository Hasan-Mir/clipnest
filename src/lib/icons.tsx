import React from 'react';
import {
    AlertTriangle,
    ArrowRight,
    BookOpen,
    Check,
    ChevronDown,
    ChevronRight,
    ChevronUp,
    Copy,
    Eye,
    File,
    Folder,
    FolderSymlink,
    GitMerge,
    Info,
    List,
    LucideProps,
    MoreHorizontal,
    PanelRight,
    Pause,
    Pencil,
    Pin,
    Play,
    Plus,
    RotateCcw,
    Search,
    Settings,
    ShoppingBasket,
    Tag,
    Trash2,
    Type,
    X,
    Zap,
} from 'lucide-react';

export type IconName =
    | 'search'
    | 'gear'
    | 'close'
    | 'dots'
    | 'pin'
    | 'tag'
    | 'trash'
    | 'edit'
    | 'info'
    | 'copy'
    | 'arrowRight'
    | 'eye'
    | 'bolt'
    | 'merge'
    | 'pause'
    | 'play'
    | 'plus'
    | 'up'
    | 'chevronDown'
    | 'chevronRight'
    | 'file'
    | 'folderSymlink'
    | 'check'
    | 'list'
    | 'richText'
    | 'folder'
    | 'basket'
    | 'reset'
    | 'sidebar'
    | 'help'
    | 'warning';

const ICON_MAP: Record<IconName, React.ComponentType<LucideProps>> = {
    search: Search,
    gear: Settings,
    close: X,
    dots: MoreHorizontal,
    pin: Pin,
    tag: Tag,
    trash: Trash2,
    edit: Pencil,
    info: Info,
    copy: Copy,
    arrowRight: ArrowRight,
    eye: Eye,
    bolt: Zap,
    merge: GitMerge,
    pause: Pause,
    play: Play,
    plus: Plus,
    up: ChevronUp,
    chevronDown: ChevronDown,
    chevronRight: ChevronRight,
    file: File,
    folderSymlink: FolderSymlink,
    check: Check,
    list: List,
    richText: Type,
    folder: Folder,
    basket: ShoppingBasket,
    reset: RotateCcw,
    sidebar: PanelRight,
    help: BookOpen,
    warning: AlertTriangle,
};

export function Icon({ name, size = 14 }: { name: IconName | string; size?: number }) {
    const Comp = ICON_MAP[name as IconName];
    if (!Comp) {
        return null;
    }
    const dirClass = name === 'chevronRight' || name === 'arrowRight' ? ' icon-dir' : '';
    return <Comp className={`icon${dirClass}`} size={size} strokeWidth={2} aria-hidden />;
}
