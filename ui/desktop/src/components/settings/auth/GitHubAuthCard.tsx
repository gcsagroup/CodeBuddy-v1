import { Github } from 'lucide-react';
import { useIntl } from '../../../i18n';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '../../ui/card';
import RepositoryConnections from './RepositoryConnections';
import { selectNativeText } from '../../../utils/nativeLocalization';

export default function GitHubAuthCard() {
  const intl = useIntl();
  return (
    <Card className="@container gap-0 border-border-primary py-0 shadow-none">
      <CardHeader className="gap-1.5 border-b border-border-primary px-4 py-4 @sm:px-5">
        <CardTitle className="flex items-center gap-2 text-sm font-semibold">
          <Github className="size-4 shrink-0 text-text-secondary" aria-hidden="true" />
          {selectNativeText(intl.locale, 'Code repositories', '代码仓库', '程式碼儲存庫')}
        </CardTitle>
        <CardDescription className="text-xs leading-relaxed">
          {selectNativeText(
            intl.locale,
            'Local Git is built in. Sign in to manage GitHub repositories.',
            '已内置本地 Git，登录后可管理 GitHub 仓库。',
            '已內建本機 Git，登入後可管理 GitHub 儲存庫。'
          )}
        </CardDescription>
      </CardHeader>
      <CardContent className="px-4 @sm:px-5">
        <RepositoryConnections />
      </CardContent>
    </Card>
  );
}
