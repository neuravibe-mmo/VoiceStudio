import { useTranslation } from 'react-i18next';
import { LanguagesIcon } from 'lucide-react';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';

const LOCALES = [
  { code: 'vi', label: 'Tiếng Việt' },
  { code: 'en', label: 'English' },
  { code: 'zh-CN', label: '简体中文' },
  { code: 'zh-TW', label: '繁體中文' },
  { code: 'ja', label: '日本語' },
  { code: 'ko', label: '한국어' },
  { code: 'es', label: 'Español' },
  { code: 'fr', label: 'Français' },
  { code: 'de', label: 'Deutsch' },
  { code: 'ru', label: 'Русский' },
  { code: 'pt', label: 'Português' },
  { code: 'it', label: 'Italiano' },
  { code: 'hi', label: 'हिन्दी' },
  { code: 'th', label: 'ไทย' },
  { code: 'id', label: 'Bahasa Indonesia' },
  { code: 'nl', label: 'Nederlands' },
  { code: 'pl', label: 'Polski' },
  { code: 'sv', label: 'Svenska' },
  { code: 'tr', label: 'Türkçe' },
  { code: 'uk', label: 'Українська' },
  { code: 'ar', label: 'العربية' },
  { code: 'gl', label: 'Galego' },
];

const SELECT_ITEMS = LOCALES.map(({ code, label }) => ({ value: code, label }));

export function SupportShortcut() {
  const { t, i18n } = useTranslation();
  const currentLang = i18n?.resolvedLanguage || i18n?.language || 'en';

  return (
    <div className="flex shrink-0 items-center">
      <Select
        items={SELECT_ITEMS}
        value={currentLang}
        onValueChange={(val) => {
          void import('@/i18n').then((m) => m.setAppLanguage(val as Parameters<typeof m.setAppLanguage>[0]));
        }}
      >
        <SelectTrigger
          size="sm"
          className="h-7 gap-1.5 border-0 bg-transparent px-2 text-xs font-normal text-muted-foreground hover:bg-muted/50 hover:text-foreground focus-visible:ring-1"
          aria-label={t('settings.language')}
        >
          <LanguagesIcon className="size-3.5 shrink-0" />
          <SelectValue />
        </SelectTrigger>
        <SelectContent align="end" alignItemWithTrigger={false} className="max-h-72 min-w-36">
          {LOCALES.map(({ code, label }) => (
            <SelectItem key={code} value={code} className="text-xs">
              {label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
}
