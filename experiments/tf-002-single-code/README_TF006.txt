TF-006 quick launch
===================

cd /workspaces/optilink

git fetch origin

git switch spike/tf-006-optigrid-v1-physical

git pull

cd experiments/tf-002-single-code

npm run lab:tunnel:tf006

Use only the fresh Sender/Receiver URLs printed by the launcher.
Phone action: tap Start once, align during the 6-second preflight, then leave the phone fixed until completion.
