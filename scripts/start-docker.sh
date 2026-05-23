root_path=$(cd `dirname $0` && cd .. && pwd)
cd "$root_path"

docker compose up -d --build
docker compose logs --follow bitsocial-seeder
