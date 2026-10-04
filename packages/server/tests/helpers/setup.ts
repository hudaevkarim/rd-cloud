/**
 * Подготовка серверных тестов.
 *
 * Главное здесь — перенаправление `DATABASE_URL` на тестовую базу ДО того, как
 * импортируется что-либо, где читается окружение. Импорты в ESM выполняются
 * до тела модуля, поэтому подмена должна произойти в отдельном модуле, который
 * импортируется первым, — иначе тесты били бы по рабочей базе.
 *
 * Именно поэтому здесь нет `import '../src/db/client.js'`: этот файл обязан
 * выполниться раньше него.
 */
import { config as loadEnv } from 'dotenv';
import { fileURLToPath } from 'node:url';

loadEnv({ path: fileURLToPath(new URL('../../../.env', import.meta.url)), quiet: true });

const testUrl = process.env.TEST_DATABASE_URL;

if (testUrl === undefined || testUrl === '') {
  throw new Error(
    'Не задан TEST_DATABASE_URL.\n' +
      'Серверные тесты бьют по живой базе и НЕ должны ходить в рабочую.\n' +
      'Создай отдельную базу и укажи её в .env:\n' +
      '  TEST_DATABASE_URL="postgresql://rdcloud:<пароль>@127.0.0.1:5432/rdcloud_test?schema=public"\n' +
      'Создать: createdb -U rdcloud rdcloud_test',
  );
}

// Имя базы дополнительно проверяется: переменная легко осталась бы от прошлого
// прогона и указывала бы на рабочую базу. Тесты с `TRUNCATE` уничтожили бы всё.
if (!/rdcloud_test/i.test(testUrl)) {
  throw new Error(
    `TEST_DATABASE_URL должен указывать на базу с именем rdcloud_test, а не на рабочую.\n` +
      `Получено: ${testUrl.replace(/\/\/([^:]+):[^@]*@/, '//$1:***@')}`,
  );
}

process.env.DATABASE_URL = testUrl;
// Тесты не пишут в DATA_DIR пользователя: файлы создаются во временном
// каталоге рядом с репозиторием.
//
// Отсчёт от tests/helpers/: `../` — это tests, `../../` — server,
// `../../..` — packages, и только `../../../..` — корень репозитория. На один
// уровень меньше каталог создавался бы внутри packages/ и попадал бы в git.
process.env.DATA_DIR = fileURLToPath(new URL('../../../../.tmp-test-data/', import.meta.url));
// Логи сервера в тестах — шум. Ошибки всё равно окажутся в выводе Vitest.
process.env.LOG_LEVEL = 'silent';
process.env.NODE_ENV = 'test';