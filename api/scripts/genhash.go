// genhash — print a bcrypt hash for a password. Used to regenerate the
// seed hash in migrations/049_super_admin.sql when rotating credentials.
//
//	go run ./scripts/genhash.go 'newpassword'
package main

import (
	"fmt"
	"os"

	"golang.org/x/crypto/bcrypt"
)

func main() {
	if len(os.Args) != 2 {
		fmt.Fprintln(os.Stderr, "usage: go run ./scripts/genhash.go '<password>'")
		os.Exit(2)
	}
	h, err := bcrypt.GenerateFromPassword([]byte(os.Args[1]), 12)
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
	fmt.Println(string(h))
}
